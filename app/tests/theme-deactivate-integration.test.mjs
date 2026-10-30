/** Identity flow, real compiled component; API/AI remain hermetic fixtures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = readFileSync(resolve(root, 'dist/embed/biq-onboard.js'), 'utf8');
const theme = () => ({clubId:'demo',status:'active',seed:{brand:'#123456',brandAlt:'#e9a405'},tokens:{light:{'--biq-color-surface-inverse':'#132334','--biq-color-inverse-text':'#ffffff','--biq-color-brand-tint':'#fff8e5','--biq-color-on-brand-tint':'#493900'},dark:{'--biq-color-surface-inverse':'#132334','--biq-color-inverse-text':'#ffffff','--biq-color-brand-tint':'#332800','--biq-color-on-brand-tint':'#ffe59a'}},gate:{passed:true},logo:null});

for (const mode of ['light','dark']) for (const width of [390,1280]) {
  test(`identity edit, apply, restore, failure and default — ${mode} ${width}`, async () => {
    const browser=await chromium.launch();
    try {
      const page=await browser.newPage({viewport:{width,height:844}});
      const errors=[]; const calls=[];
      page.on('pageerror',e=>errors.push(e.message));
      const state={theme:theme(),draftTheme:null,themeJob:{status:'succeeded',revision:'initial'}};
      await page.route('**/*',async route=>{
        const req=route.request(); const u=new URL(req.url());
        if(u.pathname==='/bundle.js') return route.fulfill({contentType:'text/javascript',body:bundle});
        if(u.pathname.endsWith('/theme')) {
          if(req.method()==='PUT') {
            const body=req.postDataJSON(); calls.push(body);
            state.draftTheme={...theme(),status:'draft',seed:{brand:body.seed_brand,brandAlt:body.seed_brand_alt,variant:body.variant}};
            state.themeJob={...state.themeJob,status:'succeeded',revision:'draft'};
          }
          return route.fulfill({json:{ok:true,...state}});
        }
        if(u.pathname.endsWith('/theme/activate')) {
          const body=req.postDataJSON();calls.push(body);
          assert.equal(body.confirmed,true);assert.equal(body.expected_revision,state.themeJob.revision);
          const previous=structuredClone(state.theme);
          state.theme=structuredClone(body.restore_previous?state.themeJob.previousTheme:state.draftTheme);
          state.theme.status='active';state.draftTheme=null;
          state.themeJob={status:'succeeded',revision:'applied',previousTheme:previous};
          return route.fulfill({json:{ok:true,theme:state.theme}});
        }
        if(u.pathname.endsWith('/theme/deactivate')) {state.theme.status='draft';return route.fulfill({json:{ok:true}});}
        if(u.pathname.endsWith('/theme/generate')) {state.themeJob={...state.themeJob,status:'unreachable'};return route.fulfill({json:{ok:true}});}
        if(u.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true}});
        const dark=mode==='dark';
        return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--biq-text:${dark?'#f4f6fb':'#0d1735'};--biq-muted:${dark?'#aab4c8':'#5f6b82'};--biq-surface:${dark?'#111a2d':'#ffffff'};--biq-surface-2:${dark?'#162039':'#eef1f6'};--biq-card:${dark?'#111a2d':'#ffffff'};--biq-surface-1:${dark?'#111a2d':'#ffffff'};--biq-surface-3:${dark?'#1b2742':'#eef1f6'};--biq-line:${dark?'#7a8ab0':'#dce2ef'};--biq-border:${dark?'#7a8ab0':'#dce2ef'};--biq-orange:${dark?'#ff6a18':'#c94500'};--biq-on-orange:${dark?'#080d1a':'#ffffff'};font:16px system-ui;color:var(--biq-text);background:${dark?'#080d1a':'#f4f6fa'}}body{margin:0}*{box-sizing:border-box}</style><biq-onboard-app></biq-onboard-app><script type="module" src="/bundle.js"></script>`});
      });
      await page.goto('https://identity.fixture/');
      await page.evaluate(async initial=>{
        await customElements.whenDefined('biq-onboard-app');
        const el=document.querySelector('biq-onboard-app');
        el._org={club:{id:'demo',name:'Club Baloncesto Prueba',website:'https://club.example'},role:'administrator'};
        el._subRoute='club-details';el._theme=initial.theme;el._themeJob=initial.themeJob;el._loading=false;el.render();
      },state);
      const apply=()=>page.getByRole('button',{name:'Aplicar identidad',exact:true});
      await apply().waitFor();assert.equal(await apply().isDisabled(),true);
      assert.equal(await page.getByRole('button',{name:'Restaurar identidad anterior'}).count(),0);
      await page.getByLabel('Color principal').fill('#224466');
      await page.getByRole('button',{name:'Más suave',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('biq-onboard-app').shadowRoot.querySelector('[data-identity-apply]').disabled);
      assert.equal(state.theme.seed.brand,'#123456');
      assert.equal(calls[0].variant,'soft');
      const savedRevision = state.themeJob.revision;
      state.themeJob.status='pending';
      await page.evaluate(()=>document.querySelector('biq-onboard-app').loadThemeData('demo'));
      assert.equal(await apply().isDisabled(),true,'apply blocked during generation');
      state.themeJob.status='succeeded';state.themeJob.revision=savedRevision;
      await page.evaluate(()=>document.querySelector('biq-onboard-app').loadThemeData('demo'));
      assert.equal(state.draftTheme.seed.brand,'#224466');
      await page.evaluate(()=>window.scrollTo(0,0));
      if(process.env.BIQ_IDENTITY_SCREENSHOTS){mkdirSync(process.env.BIQ_IDENTITY_SCREENSHOTS,{recursive:true});await page.screenshot({path:resolve(process.env.BIQ_IDENTITY_SCREENSHOTS,`${mode}-${width}.png`),fullPage:true});}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal page overflow');
      await apply().click();
      await page.getByRole('button',{name:'Restaurar identidad anterior'}).waitFor();
      assert.equal(state.theme.seed.brand,'#224466');
      await page.getByRole('button',{name:'Restaurar identidad anterior'}).click();
      await page.waitForFunction(()=>document.querySelector('biq-onboard-app').shadowRoot.querySelector('[data-identity-brand]').value==='#123456');
      assert.equal(state.theme.seed.brand,'#123456');
      await page.getByRole('button',{name:'Proponer identidad',exact:true}).click();
      await page.getByLabel('Color principal').waitFor();
      await page.waitForFunction(()=>document.querySelector('biq-onboard-app')._themeJob.status==='unreachable');
      assert.equal(state.theme.seed.brand,'#123456');
      assert.equal(await page.getByRole('button',{name:'Preparar vista previa'}).isEnabled(),true);
      await page.getByRole('button',{name:'Usar identidad BasketSpark'}).click();
      await page.waitForFunction(()=>document.querySelector('biq-onboard-app')._theme.status==='draft');
      assert.equal(state.theme.tokens.light['--biq-color-surface-inverse'],'#132334','deactivate retains tokens');
      await page.getByRole('button',{name:'Perfil',exact:true}).click();
      await page.getByRole('button',{name:'Identidad',exact:true}).click();
      await page.getByLabel('Color principal').waitFor();
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  });
}
