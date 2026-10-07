import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { startChromeForClipyCapture, startChrome, chromeStatus, stopChrome } from '../dist/chromeForClipy.js';
import { createServer } from 'node:http';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const home = mkdtempSync(join(tmpdir(), 'clipy-pr276-qa-'));
const server = createServer((_req,res) => res.end(`<!doctype html><title>Harmless test</title><h1>PR 276 local capture test</h1><button id="tone" onclick="const a=new AudioContext(); const o=a.createOscillator();o.connect(a.destination);o.start();setTimeout(()=>o.stop(),2500)">Play test tone</button><script>let n=0;setInterval(()=>{document.title='Harmless '+(++n);document.body.style.background=n%2?'#ccf':'#fcc'},500)</script>`));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));
const port=portProbe.address().port;
await new Promise(r=>portProbe.close(r));
let cap;
try {
  const opts = { home, env: process.env, platform: process.platform, port, tmpDir:join(home,'capture'), targetUrl:url, log: console.log };
  assert.equal((await startChrome(home, process.env, process.platform, port)).ok, true);
  const driver = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const unrelated = await driver.contexts()[0].newPage();
  try {
    await unrelated.goto('data:text/html,<title>clipy-rec unrelated tab</title>');
    await assert.rejects(startChromeForClipyCapture(chromium, opts), /Another tab contains the capture marker/);
    assert.equal(unrelated.isClosed(), false, 'ambiguous tabs must never be closed by capture cleanup');
  } finally {
    await unrelated.close();
    await driver.close();
  }
  cap = await startChromeForClipyCapture(chromium,opts);
  await assert.rejects(startChromeForClipyCapture(chromium,{...opts,tmpDir:join(home,'concurrent')}), /active capture/);
  await cap.page.click('#tone');
  await new Promise(r=>setTimeout(r,3500));
  assert.match(await cap.page.title(), /^Harmless /);
  const path = await cap.stop(); cap = null;
  assert.ok(statSync(path).size>1000);
  const probe = spawnSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',path],{encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  const media = JSON.parse(probe.stdout);
  assert.ok(media.streams.some(s => s.codec_type === 'audio'), 'tab audio must be present');
  assert.ok(media.streams.some(s => s.codec_type === 'video'), 'tab video must be present');
  console.log('MEDIA',probe.stdout.trim());
  assert.equal((await chromeStatus(home,process.platform)).running,true,'stopping capture leaves Chrome running');
  cap = await startChromeForClipyCapture(chromium,{...opts,tmpDir:join(home,'abort')});
  await cap.discard(); cap=null;
  const b=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  assert.ok(b.contexts()[0].pages().every(p=>!p.url().includes('/recorder.html')&&!p.url().startsWith(url)),'capture tabs cleaned');
  await b.close();
  cap = await startChromeForClipyCapture(chromium,{...opts,tmpDir:join(home,'failed')});
  const recorder = cap.browser.contexts()[0].pages().find(p=>p.url().endsWith('/recorder.html'));
  await recorder.close();
  await assert.rejects(cap.stop(), /closed/); cap=null;
  assert.equal((await chromeStatus(home,process.platform)).running,true);
  console.log('PASS: capture with changing titles + tab audio, flush, abort, repeated capture, tab cleanup, failed-recorder rejection, concurrent capture refusal, browser remains running');
} finally {
  if(cap) await cap.discard().catch(()=>{});
  console.log('STOP',await stopChrome(home));
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await new Promise(r=>setTimeout(r,1000));
  rmSync(home,{recursive:true,force:true});
}
