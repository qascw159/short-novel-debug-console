import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({headless:true,channel:'chrome'});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let providerSaved, defaultSaved, requestSent;
await page.route('**/api/**', async route => {
  const req = route.request();
  const url = new URL(req.url());
  let response = {};
  if (url.pathname.endsWith('/debug-config')) {
    const body = req.method() === 'PUT' ? req.postDataJSON() : null;
    if (body) defaultSaved = body;
    const language = body?.language || url.searchParams.get('language') || 'zh-CN';
    response = {language,default_model:'test-model',default_temperature:.7,persisted:true,
      prompts:{clarification_system:language === 'en-US' ? 'English clarification' : '中文澄清',novel_system:'Novel prompt'},
      model_suggestions:['test-model']};
  } else if (url.pathname.endsWith('/provider-settings/test')) {
    const body = req.postDataJSON();
    assert.equal(body.model,'test-model');
    response = {ok:true,code:'OK',message:'连接成功',elapsed_ms:123,upstream_status:200};
  } else if (url.pathname.endsWith('/provider-settings')) {
    if(req.method() === 'PUT') providerSaved = req.postDataJSON();
    response = {base_url:'https://example.test/v1',api_key_configured:true,thinking_mode:'omit'};
  } else if (url.pathname.endsWith('/stream')) {
    requestSent = req.postDataJSON();
    return route.fulfill({status:200,contentType:'text/event-stream',body:
      'data:'+JSON.stringify({type:'clarification_card',session_id:'test-session',payload:{card:{
        question:'What happened?',card_type:'text_input',allow_custom:true,round:1,max_rounds:3,options:[]
      }}})+'\n\n'});
  }
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(response)});
});
try {
  await page.goto('http://127.0.0.1:5178');
  await page.locator('#languageInput').selectOption('en-US');
  await page.waitForFunction(() => document.querySelector('#promptEditor').value === 'English clarification');
  await page.locator('#apiToken').fill('test-service-token');
  await page.locator('#providerUrl').fill('https://example.test/v1');
  await page.locator('#providerKey').fill('test-secret');
  await page.locator('#testProvider').click();
  await page.waitForFunction(() => document.querySelector('#providerTestResult').textContent.includes('123 ms'));
  assert.equal(providerSaved, undefined);
  await page.locator('#saveProvider').click();
  await page.waitForFunction(() => document.querySelector('#providerKey').value === '');
  assert.equal(providerSaved.api_key,'test-secret');
  await page.locator('#saveDefaults').click();
  await page.waitForTimeout(100);
  assert.equal(defaultSaved.language,'en-US');
  await page.locator('#userProfileInput').fill(JSON.stringify({occupation:'designer'}));
  await page.locator('#safetyMode').selectOption('false');
  await page.locator('#queryInput').fill('今天工作很开心');
  await page.locator('#sendQuery').click();
  await page.waitForFunction(() => document.body.textContent.includes('What happened?'));
  assert.equal(requestSent.language,'en-US');
  assert.equal(requestSent.safety_enabled,false);
  assert.equal(requestSent.user_profile.occupation,'designer');
  assert(!JSON.stringify(requestSent).includes('test-secret'));
  assert(!await page.evaluate(() => JSON.stringify(localStorage).includes('test-secret')));
  await page.locator('#settings').evaluate(el => el.scrollTop = 0);
  await page.screenshot({path:'/tmp/novel-language-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#openSettings').click();
  await page.waitForTimeout(300);
  await page.locator('#settings').evaluate(el => el.scrollTop = 0);
  await page.screenshot({path:'/tmp/novel-language-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: language defaults, provider write-only key, request language, desktop/mobile screenshots');
} finally { await browser.close(); }
