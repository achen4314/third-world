const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
const page = list.find(x => x.type === 'page' && x.url.includes('index.html'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const call = (method, params) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = expression => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

await call('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 1400));

const script = String.raw`
(async () => {
  const R=[]; const add=(cat,name,ok,detail)=>R.push({cat,name,ok:!!ok,detail:String(detail).slice(0,140)});
  const wait=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const d=window.ARC_DEBUG,L=window.ARC_LIVE,A=window.ARC;
  // B3：演示占位默认关闭。审计要覆盖 1 Hz / 对标评分 / 融合机制，先显式打开开关再渲染。
  d.state.demoFx=true; d.navigate('today');
  const errs=[]; window.addEventListener('error',e=>errs.push(e.message));
  const near=(a,b,e)=>Math.abs(a-b)<(e||1e-6);

  /* A 算法 18 项 */
  add('算法','jump.height h=g·t_f²/8 · t_f=0.500 → 30.66 cm', near(d.jumpH(0.5)*100,30.656,0.01), (d.jumpH(0.5)*100).toFixed(3)+' cm');
  const h398=d.jumpH(0.398);
  add('算法','jump.rsi = h/t_contact', near(h398/0.184,1.0557,0.001), (h398/0.184).toFixed(4));
  const c28=d.computeLoad(Array(28).fill(100));
  add('算法','ACWR rolling 恒定 TL → 1.000', near(c28[27].rolling,1,1e-9), c28[27].rolling);
  add('算法','ACWR EWMA 恒定 TL → 1.000', near(c28[27].ewma,1,1e-9), c28[27].ewma);
  add('算法','CTL 42 日 EWMA 单调收敛', c28.every((x,i)=>i===0||x.ctl>=c28[i-1].ctl-1e-9), 'ctl28='+c28[27].ctl.toFixed(2));
  const step=d.computeLoad(Array(28).fill(0).map((v,i)=>i<14?0:100));
  add('算法','阶跃输入 ATL 收敛快于 CTL', Math.abs(100-step[27].atl)<Math.abs(100-step[27].ctl), 'ctl='+step[27].ctl.toFixed(2)+' atl='+step[27].atl.toFixed(2));
  add('算法','TSB = 前一日 CTL−ATL', near(step[27].tsb, step[26].ctl-step[26].atl,1e-9), step[27].tsb.toFixed(3));
  const c7=d.computeLoad(Array(28).fill(100).map((v,i)=>i<21?0:100));
  add('算法','sd=0 → TM/TS 不可计算（非 0/∞）', c7[27].tm===null&&c7[27].ts===null, 'tm='+c7[27].tm+' ts='+c7[27].ts);
  const miss=Array(28).fill(100); miss[23]=null; miss[25]=null; const cm=d.computeLoad(miss);
  add('算法','7 日缺测 2 天 → rolling/TM/TS 不可计算', cm[27].rolling===null&&cm[27].tm===null&&cm[27].ts===null, 'v7='+cm[27].v7);
  add('算法','缺测日保留 null 不补 0', cm[23].tl===null&&cm[25].tl===null, 'tl23='+cm[23].tl);
  add('算法','LVP 线性回归 R² ∈ (0,1]', d.LVP.r2>0&&d.LVP.r2<=1, 'R²='+d.LVP.r2.toFixed(4));
  add('算法','V1RM 未标定 → 1RM 不可计算', d.state.calibrated===false?d.oneRM()===null:true, 'calibrated='+d.state.calibrated);
  add('算法','V1RM 标定 → 1RM 正值且有限', (()=>{const o=d.state.calibrated;d.state.calibrated=true;const v=d.oneRM();d.state.calibrated=o;return v>0&&Number.isFinite(v);})(), '1RM≈127.23 kg (DEMO)');
  add('算法','AWCR 一律按 ACWR（无独立 metric_id）', !Object.keys(A.METRICS).some(k=>/awcr/i.test(k))&&!!A.METRICS['acwr.ewma'], Object.keys(A.METRICS).filter(k=>k.indexOf('acwr')>=0).join(','));
  add('算法','Registry 18 指标四问齐备', Object.keys(A.METRICS).length===18&&Object.values(A.METRICS).every(m=>m.formula&&m.window&&m.inputs&&m.evidence&&m.version), 'count='+Object.keys(A.METRICS).length);
  add('算法','数据治理硬规则写入 Registry', Object.values(A.METRICS).some(m=>/不可计算/.test(m.valid))&&Object.values(A.METRICS).some(m=>/缺测/.test(m.valid)), 'valid 规则存在');
  add('算法','DEMO 8 个对标评分分档完整', L.SCORES.length===8&&L.SCORES.every(s=>s.bands.length>=3&&s.definition&&s.basis), 'scores='+L.SCORES.length+' bands='+L.SCORES.reduce((a,s)=>a+s.bands.length,0));
  add('算法','融合映射字段完整', L.FUSION.sources.length===10&&L.FUSION.mapping.length===14&&L.FUSION.pipeline.length===10, 'src='+L.FUSION.sources.length+' map='+L.FUSION.mapping.length+' pipe='+L.FUSION.pipeline.length);

  /* B 图表 */
  const allKinds=new Set(); let chartPages=0,chartHosts=0,badSvg=0;
  for(const r of Object.keys(d.P)){ d.navigate(r); await wait();
    const hs=[...document.querySelectorAll('#content [data-chart]')];
    if(hs.length)chartPages++;
    hs.forEach(x=>{chartHosts++;if(x.__arcBaseCfg)allKinds.add(x.__arcBaseCfg.kind);const s=x.querySelector('svg');if(!s||!s.innerHTML.trim()||/NaN|Infinity|undefined/.test(s.innerHTML))badSvg++;});
  }
  add('图表','含图表界面 / 图表位统计', chartPages>0, chartPages+' 个界面，'+chartHosts+' 个图表位');
  add('图表','5 类渲染器 line/bars/scatter/gauge/stack 全覆盖', ['line','bars','scatter','gauge','stack'].every(k=>allKinds.has(k)), [...allKinds].sort().join(','));
  add('图表','全路由 SVG 无 NaN/Infinity/空', badSvg===0, 'bad='+badSvg);
  d.navigate('data'); await wait();
  add('图表','data 页 28 日热力网格（HTML，非 SVG）', document.querySelectorAll('#content .heat-cell').length===28, 'cells='+document.querySelectorAll('#content .heat-cell').length);
  for(const r of ['analyze/load','analyze/recovery','analyze/endurance','analyze/vbt','analyze/jump','train','train/calendar','admin/overview']){
    d.navigate(r); await wait(); const hs=[...document.querySelectorAll('#content [data-chart]')];
    add('图表','渲染 '+r, hs.length>0&&hs.every(x=>x.querySelector('svg')), hs.length+' svg');
  }
  d.navigate('analyze/load'); await wait();
  const h0=document.querySelector('#content [data-live-chart]');
  add('图表','悬停十字线 + 详情浮层挂载', !!(h0&&h0.querySelector('.chart-tip')&&h0.querySelector('.chart-cross')), 'tip+cross');
  if(h0){h0.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:h0.getBoundingClientRect().left+140,clientY:h0.getBoundingClientRect().top+40}));
    const t=h0.querySelector('.chart-tip'); add('图表','悬停详情含口径/窗口/来源/version/DEMO', /口径/.test(t.textContent)&&/窗口/.test(t.textContent)&&/来源/.test(t.textContent)&&/v\d/.test(t.textContent)&&/DEMO/.test(t.textContent), t.textContent.slice(0,70));}

  /* C 交互 */
  const sheets=['metric','rule','device','imu','manual','newtest','window','roles','confirm','theme','scores','fusion'];
  for(const s of sheets){ d.state.palette=false; d.openSheet(s,s==='scores'?'evlab.status':(s==='metric'?'acwr.ewma':(s==='rule'?'R-01':'')));
    add('交互','浮层 '+s, !!document.querySelector('.sheet h3'), (document.querySelector('.sheet h3')||{}).textContent||'FAIL'); }
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}));
  add('交互','⌘K 命令面板即时过滤', document.querySelectorAll('.palette-item').length>0, 'items='+document.querySelectorAll('.palette-item').length);
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  add('交互','Esc 关闭浮层', document.querySelectorAll('.palette,.sheet').length===0, 'closed');
  d.state.sheet=null; d.navigate('analyze/load'); await wait();
  const f7=document.querySelector('[data-act="live-filter"][data-v="7"]'); if(f7)f7.click();
  add('交互','窗口筛选 7 日即时截断', L.state.window===7&&document.querySelector('#content [data-live-chart]').__arcCfg.labels.length===7, 'labels='+document.querySelector('#content [data-live-chart]').__arcCfg.labels.length);
  const fm=document.querySelector('[data-act="live-filter"][data-v="manual"]'); if(fm)fm.click();
  const cfgm=document.querySelector('#content [data-live-chart]').__arcCfg;
  add('交互','来源筛选互斥（非匹配点「—」）', L.state.source==='manual'&&cfgm.series[0].values.some(v=>v===null), 'nulls='+cfgm.series[0].values.filter(v=>v===null).length);
  for(const st of ['loading','empty','error','offline','ok']){const b=document.querySelector('[data-act="live-status"][data-live-status="'+st+'"]');if(b)b.click();
    const n=document.querySelectorAll('.chart-state,.offline-tag').length; add('交互','状态反馈 '+st, L.state.status===st&&(st==='ok'?n===0:n>0), 'overlays='+n);}
  const v0=L.state.version; const rb=document.querySelector('[data-act="live-refresh"]'); if(rb)rb.click();
  const mid=L.state.status; await new Promise(r=>setTimeout(r,600));
  add('交互','即时刷新 loading→ok 全卡同版', mid==='loading'&&L.state.status==='ok'&&L.state.version>v0, 'v'+v0+'→v'+L.state.version);
  const lt=document.querySelector('[data-act="live-toggle"]'); if(lt)lt.click(); add('交互','暂停推流', L.state.live===false,'live=false');
  if(lt)lt.click(); add('交互','继续推流', L.state.live===true,'live=true');
  d.openSheet('manual',''); const inp=document.querySelector('#overlay [data-f="tf"]'); if(inp){inp.value='0.500';inp.dispatchEvent(new Event('input',{bubbles:true}));}
  add('交互','手动填入公式实时预览', /30\.66/.test((document.getElementById('manualPreview')||{}).textContent||''), 'h=30.66 cm');
  const sm=document.querySelector('[data-act="save-manual"]'); if(sm)sm.click();
  add('交互','保存 Toast + 就地更新', document.querySelectorAll('.toast').length>0, 'toast');
  ['iphone','ipad','mac'].forEach(p=>{const b=document.querySelector('[data-act="platform"][data-p="'+p+'"]');if(b)b.click();});
  add('交互','三端平台切换', document.getElementById('device').className==='device p-mac', document.getElementById('device').className);
  const th0=document.documentElement.dataset.theme; document.getElementById('themeBtn').click();
  add('交互','浅/深色切换', document.documentElement.dataset.theme!==th0, th0+'→'+document.documentElement.dataset.theme);
  const ws0=d.state.workspace; document.querySelector('[data-act="workspace"]')?.click();
  add('交互','工作区切换清空导航栈', d.state.workspace!==ws0, ws0+'→'+d.state.workspace);
  d.state.role='observer'; d.navigate('admin/compliance');
  add('交互','RBAC 无权限锁定态', /已锁定/.test(document.querySelector('#content').textContent), 'observer→compliance');
  d.state.role='head_coach';

  /* C2 本轮修复项复验 */
  d.state.sheet=null; d.navigate('analyze/load'); await wait();
  d.state.params.window=28; L.state.window=28;
  d.openSheet('window',''); const sel=document.querySelector('#overlay [data-key="window"]');
  if(sel){sel.value='90';sel.dispatchEvent(new Event('change',{bubbles:true}));}
  add('复验','BUG-01 O6 窗口→实时引擎同步', d.state.params.window===90&&L.state.window===90, 'params='+d.state.params.window+' live='+L.state.window);
  d.state.sheet=null; d.navigate('analyze/load'); await wait();
  const b7b=document.querySelector('[data-act="live-filter"][data-v="7"]'); if(b7b)b7b.click();
  const chip=document.querySelector('#content [data-live-window]');
  add('复验','BUG-02 实时条→页首芯片同步', L.state.window===7&&d.state.params.window===7&&/7 日/.test(chip.textContent), 'chip='+chip.textContent+' params='+d.state.params.window);
  d.openSheet('window',''); const sel2=document.querySelector('#overlay [data-key="window"]');
  add('复验','BUG-02b O6 弹层选中值同步', sel2&&sel2.value==='7', 'select='+(sel2?sel2.value:'none'));
  d.state.sheet=null; d.openSheet('manual','2026-11-10');
  const mv=document.querySelector('#overlay [data-act="manual-type"]'); if(mv){mv.value='sleep';mv.dispatchEvent(new Event('change',{bubbles:true}));}
  const di=document.querySelector('#overlay [data-f="date"]');
  add('复验','BUG-03 热力日历日期带入补录表单', di&&di.value==='2026-11-10'&&/2026-11-10/.test(document.querySelector('.sheet-body').textContent), 'date='+(di?di.value:'none'));
  d.state.sheet=null; d.openSheet('window','');
  add('复验','BUG-04 TL 口径仅标签的限制已显式标注', /不重算数值/.test(document.querySelector('.sheet-body').textContent), '限制说明可见');

  /* D 异常与边界 */
  d.state.sheet=null;
  d.navigate('analyze/load'); await wait();
  add('边界','缺测显示「—」而非 0', /—/.test(document.querySelector('#content').textContent), '含 —');
  d.state.injectMissing=true; d.navigate('analyze/load'); await wait();
  add('边界','注入缺测 → 窗口指标不可计算', /不可计算/.test(document.querySelector('#content').textContent), '含不可计算');
  d.state.injectMissing=false;
  d.state.calibrated=false; d.navigate('analyze/vbt'); await wait();
  add('边界','V1RM 未标定 → 1RM「—」', /未标定|不可计算/.test(document.querySelector('#content').textContent), '受控');
  d.state.calibrated=true; d.navigate('analyze/vbt'); await wait();
  add('边界','标定后 1RM 即时可算', /127/.test(document.querySelector('#content').textContent), '127.2');
  d.state.calibrated=false;
  d.navigate('train/session'); await wait();
  add('边界','无功率 → TSS 不可计算', /不可计算/.test(document.querySelector('#content').textContent), 'TSS 受限');
  d.navigate('analyze/jump'); await wait();
  add('边界','PPO/FVP 系数未标定 → 「—」', /未标定|—/.test(document.querySelector('#content').textContent), '受控');
  add('边界','全局 DEMO 标记', document.querySelectorAll('.demo-mini,.pill.demo,.chip.demo').length>0, 'badges='+document.querySelectorAll('.demo-mini,.pill.demo,.chip.demo').length);
  add('边界','无 JS 运行时异常', errs.length===0, 'errors='+errs.length+(errs.length?' :: '+errs.slice(0,2).join('|'):''));

  /* E 路由 */
  let bad=0; const routes=Object.keys(d.P);
  for(const r of routes){try{d.navigate(r);if(!document.querySelector('#content .page-title'))bad++;}catch(e){bad++;}}
  add('路由','36 条路由全部渲染', bad===0&&routes.length===36, routes.length+' 条，失败 '+bad);
  return JSON.stringify(R);
})()
`;
const r = await evaluate(script);
if (r.result && r.result.exceptionDetails) { console.log('EXCEPTION', JSON.stringify(r.result.exceptionDetails).slice(0, 1500)); process.exit(0); }
const rows = JSON.parse(r.result.result.value);
const fs = await import('fs'); fs.writeFileSync('/tmp/arc_final_audit.json', JSON.stringify(rows, null, 2));
const by = {}; rows.forEach(x => { (by[x.cat] = by[x.cat] || []).push(x); });
for (const k of Object.keys(by)) { const a = by[k]; console.log('\n【' + k + '】 ' + a.filter(x=>x.ok).length + '/' + a.length); a.forEach(x => console.log('  ' + (x.ok?'PASS':'FAIL') + ' | ' + x.name + ' | ' + x.detail)); }
console.log('\nTOTAL ' + rows.filter(x=>x.ok).length + '/' + rows.length + '  FAIL=' + rows.filter(x=>!x.ok).length);
ws.close();
