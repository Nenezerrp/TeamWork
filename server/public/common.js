// common.js - 共享工具函数
const $=id=>document.getElementById(id);
const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AVC=['linear-gradient(135deg,#6366f1,#a855f7)','linear-gradient(135deg,#06b6d4,#3b82f6)','linear-gradient(135deg,#f59e0b,#ef4444)','linear-gradient(135deg,#10b981,#06b6d4)'];
function avC(n){let h=0;for(const c of n)h=((h<<5)-h+c.charCodeAt(0))|0;return AVC[Math.abs(h)%AVC.length]}
const TC={summary:'#34d399',decision:'#a78bfa',feature:'#8b5cf6',bugfix:'#f43f5e',discovery:'#38bdf8',change:'#fbbf24',gotcha:'#fb923c'};
const NC={ready:'var(--rdy)',injected:'var(--inj)',running:'var(--run)',done:'var(--dn)',blocked:'var(--blk)'};
// 身份系统：UUID clientId 作为真实身份，name 仅用于显示（同名可共存）
function getClientId(){let id=localStorage.getItem('tw-client-id');
if(!id){id='u-'+crypto.randomUUID().slice(0,8);localStorage.setItem('tw-client-id',id);}return id;}
function setMyInfo(name){localStorage.setItem('tw-display-name',name);}
function api(method,path,body){
const t=localStorage.getItem('tw-token')||'';const cid=getClientId();
const opt={method,headers:{'Content-Type':'application/json; charset=utf-8',...(t?{Authorization:'Bearer '+t}:{})}};
if(body)opt.body=JSON.stringify({...body,_clientId:cid});
return fetch(path,opt).then(async r=>{const j=await r.json().catch(()=>({}));
if(r.status===401){localStorage.removeItem('tw-token');location.href='/';throw new Error('unauthorized');}return j;});}
function logout(){localStorage.removeItem('tw-token');location.href='/';}
function checkAuth(then){api('GET','/api/me').then(r=>{if(r&&r.name)then(r);else location.href='/';}).catch(()=>location.href='/');}
function fmtT(t){return new Date(t).toTimeString().slice(0,8)}
