// Rooted In Liberty admin dashboard (Cloudflare Worker "ril-admin")
// Shows site stats from the D1 database "ril-stats" (binding: DB).
// Login is handled by Cloudflare Access. This Worker also checks the Access
// token itself and refuses everyone unless these plain variables are set:
//   TEAM_DOMAIN  e.g. rootedinliberty.cloudflareaccess.com
//   POLICY_AUD   the Access application's "Application Audience (AUD) Tag"
//   ADMIN_EMAIL  cary.bergeron@gmail.com (comma-separate to add more people)

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let certCache = { at: 0, keys: [] };

async function accessEmail(request, env) {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD || !env.ADMIN_EMAIL) return { ok: false, why: "Admin login isn't set up yet." };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, why: "Please sign in through Cloudflare Access." };
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return { ok: false, why: "Bad sign-in token." };
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (Date.now() - certCache.at > 3600_000) {
    const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, why: "Unknown sign-in key." };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const allowed = env.ADMIN_EMAIL.toLowerCase().split(",").map((x) => x.trim());
  if (!valid || !aud.includes(env.POLICY_AUD) || payload.exp * 1000 < Date.now()) return { ok: false, why: "Sign-in expired. Reload to sign in again." };
  if (!allowed.includes(String(payload.email || "").toLowerCase())) return { ok: false, why: "This account isn't allowed here." };
  return { ok: true, email: payload.email };
}

async function stats(env, days) {
  const cut = `strftime('%Y-%m-%dT%H:%M:%SZ','now','-${days} days')`;
  const cut2 = `strftime('%Y-%m-%dT%H:%M:%SZ','now','-${days} days','-${days} days')`;
  const q = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const [summary, daily, geo, sources, devices] = await Promise.all([
    q(`WITH c AS (SELECT ${cut} AS cut, ${cut2} AS cut2) SELECT
        COALESCE(SUM(e.type='visit' AND e.ts>=c.cut),0) AS visits, COALESCE(SUM(e.type='signup' AND e.ts>=c.cut),0) AS signups,
        COALESCE(SUM(e.type='download' AND e.ts>=c.cut),0) AS downloads, COALESCE(SUM(e.type='visit' AND e.ts<c.cut),0) AS prev_visits,
        COALESCE(SUM(e.type='signup' AND e.ts<c.cut),0) AS prev_signups, COALESCE(SUM(e.type='download' AND e.ts<c.cut),0) AS prev_downloads
        FROM c LEFT JOIN events e ON e.ts >= c.cut2`),
    q(`SELECT substr(ts,1,10) AS day, SUM(type='signup') AS signups, SUM(type='download') AS downloads, SUM(type='visit') AS visits
        FROM events WHERE ts >= ${cut} GROUP BY day ORDER BY day`),
    q(`SELECT COALESCE(country,'Unknown') AS country, COALESCE(region,'Unknown') AS region, COALESCE(city,'Unknown') AS city,
        SUM(type='signup') AS signups, SUM(type='download') AS downloads, SUM(type='visit') AS visits
        FROM events WHERE ts >= ${cut} GROUP BY 1,2,3 ORDER BY signups DESC, downloads DESC, visits DESC LIMIT 100`),
    q(`SELECT COALESCE(NULLIF(source,''),'direct') AS source, SUM(type='signup') AS signups, SUM(type='download') AS downloads, SUM(type='visit') AS visits
        FROM events WHERE ts >= ${cut} GROUP BY 1 ORDER BY signups DESC, downloads DESC, visits DESC LIMIT 50`),
    q(`SELECT COALESCE(device,'unknown') AS device, COUNT(*) AS n FROM events WHERE type='visit' AND ts >= ${cut} GROUP BY 1 ORDER BY n DESC`),
  ]);
  return { days, summary: summary[0], daily, geo, sources, devices };
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Rooted In Liberty Admin</title>
<style>
:root{--navy:#242567;--red:#B2091A;--cream:#F8F2D8;--ink:#1E1E24;--muted:#5b5c6e;--line:#e3dcc0}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 Georgia,serif;color:var(--ink);background:#FDFBF3}
header{background:var(--navy);color:#fff;border-bottom:4px solid var(--red)}
.wrap{max-width:1100px;margin:0 auto;padding:18px 20px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
h1{font-size:22px;margin:0}h1 small{display:block;font:600 11px/1.6 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;opacity:.8}
.who{font:13px Arial,sans-serif;opacity:.9}.who a{color:#fff}
select{font:15px Arial,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:#fff}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:22px 0 12px}
.take{margin:0;color:var(--muted)}.take b{color:var(--ink)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px}
.lbl{font:600 12px Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--red);margin:0}
.big{font-size:40px;color:var(--navy);margin:4px 0;font-variant-numeric:tabular-nums}
.delta{font:13px Arial,sans-serif;color:var(--muted);margin:0}.up{color:#1a7f37}.down{color:var(--red)}
h2{font-size:19px;color:var(--navy);margin:0 0 4px}.note{font:13px Arial,sans-serif;color:var(--muted);margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr));gap:14px;margin-top:14px}
.sec{margin-top:14px}
.legend{font:13px Arial,sans-serif;color:var(--muted);display:flex;gap:16px;margin-bottom:6px}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}
#chart{position:relative}#tip{position:absolute;pointer-events:none;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:13px Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.12);display:none;white-space:nowrap}
.tbox{max-height:380px;overflow:auto}table{width:100%;border-collapse:collapse;font:14px Arial,sans-serif}
th{position:sticky;top:0;background:#fff;text-align:left;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:2px solid var(--line)}
td{padding:6px 8px;border-bottom:1px solid var(--line)}.n{text-align:right;font-variant-numeric:tabular-nums}
.empty{font:14px Arial,sans-serif;color:var(--muted)}
footer{font:12px Arial,sans-serif;color:var(--muted);text-align:center;padding:30px 0}
</style></head><body>
<header><div class="wrap top"><h1><small>Rooted In Liberty</small>Site stats</h1><div class="who">Signed in as <span id="who"></span> &middot; <a href="/cdn-cgi/access/logout">Sign out</a></div></div></header>
<main class="wrap">
<div class="bar"><p class="take" id="take">Loading&hellip;</p>
<select id="days" aria-label="Time range"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select></div>
<div class="tiles">
<div class="card"><p class="lbl">Form signups</p><div class="big" id="signups">&mdash;</div><p class="delta"><span id="d_signups"></span> vs the period before</p></div>
<div class="card"><p class="lbl">Book downloads</p><div class="big" id="downloads">&mdash;</div><p class="delta"><span id="d_downloads"></span> vs the period before</p></div>
<div class="card"><p class="lbl">Site visits</p><div class="big" id="visits">&mdash;</div><p class="delta"><span id="d_visits"></span> vs the period before</p></div>
<div class="card"><p class="lbl">Signup rate</p><div class="big" id="rate">&mdash;</div><p class="delta">Signups per 100 visits</p></div>
</div>
<div class="card sec"><h2>Signups and downloads by day</h2><p class="note">Hover a day for its numbers. Days are in UTC.</p>
<div class="legend"><span><i class="sw" style="background:#242567"></i>Signups</span><span><i class="sw" style="background:#B2091A"></i>Downloads</span></div>
<div id="chart"><div id="tip"></div></div></div>
<div class="grid">
<div class="card"><h2>Where readers are</h2><p class="note">Country, state and city. Top 100 places.</p><div class="tbox"><table><thead><tr><th>Country</th><th>State</th><th>City</th><th class="n">Signups</th><th class="n">Downloads</th><th class="n">Visits</th></tr></thead><tbody id="geo"></tbody></table></div></div>
<div class="card"><h2>Where they came from</h2><p class="note">From the link's ?src= tag (for example ?src=fb), or the page or email a download came from.</p><div class="tbox"><table><thead><tr><th>Source</th><th class="n">Signups</th><th class="n">Downloads</th><th class="n">Visits</th></tr></thead><tbody id="src"></tbody></table></div>
<h2 style="margin-top:18px">Devices</h2><p class="note">Visits by device.</p><table><tbody id="dev"></tbody></table></div>
</div>
</main><footer>Private admin page. Visitor IP addresses are never stored.</footer>
<script>
const $=(id)=>document.getElementById(id), fmt=(n)=>Number(n||0).toLocaleString('en-US');
const cell=(t,c)=>{const td=document.createElement('td');td.textContent=t;if(c)td.className=c;return td};
function rows(tb,data,cols,emptyText){tb.replaceChildren();if(!data.length){const tr=document.createElement('tr');tr.append(cell(emptyText,'empty'));tr.firstChild.colSpan=cols.length;tb.append(tr);return}
 data.forEach(r=>{const tr=document.createElement('tr');cols.forEach(([k,n])=>tr.append(cell(n?fmt(r[k]):r[k],n?'n':'')));tb.append(tr)})}
function delta(id,c){const el=$(id);el.className=c>0?'up':c<0?'down':'';el.textContent=(c>0?'+':'')+fmt(c)}
function chart(daily,days){
 const box=$('chart'),tip=$('tip');box.querySelectorAll('svg').forEach(s=>s.remove());
 const by=new Map(daily.map(r=>[r.day,r])),list=[],end=new Date();end.setUTCHours(0,0,0,0);
 for(let i=days-1;i>=0;i--){const d=new Date(end);d.setUTCDate(end.getUTCDate()-i);const k=d.toISOString().slice(0,10),r=by.get(k)||{};list.push({k,d,s:r.signups||0,dl:r.downloads||0})}
 const W=box.clientWidth||700,H=240,L=36,R=8,T=8,B=26,max=Math.max(4,...list.map(x=>Math.max(x.s,x.dl)));
 const step=(W-L-R)/list.length,bw=Math.max(1,Math.min(14,step*0.36));const y=v=>H-B-(v/max)*(H-B-T);
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('width','100%');
 const add=(tag,a)=>{const e=document.createElementNS(ns,tag);for(const k in a)e.setAttribute(k,a[k]);svg.append(e);return e};
 [0,.5,1].forEach(f=>{const v=Math.round(max*f);add('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),stroke:'#eee7cf'});const t=add('text',{x:L-6,y:y(v)+4,'text-anchor':'end','font-size':11,fill:'#5b5c6e','font-family':'Arial'});t.textContent=fmt(v)});
 const every=Math.max(1,Math.ceil(list.length/Math.max(2,Math.floor((W-L)/64))));
 list.forEach((x,i)=>{const cx=L+i*step+step/2;
  add('rect',{x:cx-bw-1,y:y(x.s),width:bw,height:H-B-y(x.s),rx:2,fill:'#242567'});add('rect',{x:cx+1,y:y(x.dl),width:bw,height:H-B-y(x.dl),rx:2,fill:'#B2091A'});
  if(i%every===0){const t=add('text',{x:cx,y:H-8,'text-anchor':'middle','font-size':11,fill:'#5b5c6e','font-family':'Arial'});t.textContent=x.d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})}
  const hit=add('rect',{x:L+i*step,y:T,width:step,height:H-T-B,fill:'transparent'});
  hit.addEventListener('mousemove',ev=>{tip.style.display='block';tip.textContent='';const a=document.createElement('div');a.style.color='#5b5c6e';a.textContent=x.d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});const b=document.createElement('div');b.textContent='Signups: '+fmt(x.s);const c=document.createElement('div');c.textContent='Downloads: '+fmt(x.dl);tip.append(a,b,c);
   const rb=box.getBoundingClientRect();tip.style.left=Math.min(rb.width-tip.offsetWidth,ev.clientX-rb.left+12)+'px';tip.style.top=Math.max(0,ev.clientY-rb.top-60)+'px'});
  hit.addEventListener('mouseleave',()=>tip.style.display='none')});
 add('line',{x1:L,x2:W-R,y1:H-B,y2:H-B,stroke:'#c9c2a4'});box.prepend(svg)}
let last=null;
async function load(){const days=Number($('days').value);$('take').textContent='Loading\\u2026';
 const r=await fetch('/api/stats?days='+days,{credentials:'same-origin'});if(!r.ok){$('take').textContent='Could not load stats ('+r.status+'). Try reloading the page.';return}
 const d=await r.json();last=d;const s=d.summary;$('who').textContent=d.email||'';
 ['signups','downloads','visits'].forEach(k=>{$(k).textContent=fmt(s[k]);delta('d_'+k,s[k]-s['prev_'+k])});
 $('rate').textContent=s.visits?(100*s.signups/s.visits).toFixed(1)+'%':'\\u2014';
 const span=days===365?'last 12 months':'last '+days+' days';
 $('take').textContent=(s.visits+s.signups+s.downloads)?fmt(s.signups)+' signups and '+fmt(s.downloads)+' downloads from '+fmt(s.visits)+' visits in the '+span+'.':'No visits, signups or downloads in the '+span+' yet.';
 chart(d.daily,days);
 rows($('geo'),d.geo,[['country'],['region'],['city'],['signups',1],['downloads',1],['visits',1]],'No places yet.');
 rows($('src'),d.sources,[['source'],['signups',1],['downloads',1],['visits',1]],'No sources yet.');
 rows($('dev'),d.devices,[['device'],['n',1]],'No visits yet.')}
$('days').addEventListener('change',load);addEventListener('resize',()=>{if(last)chart(last.daily,last.days)});load();
</script></body></html>`;

export default {
  async fetch(request, env) {
    const auth = await accessEmail(request, env).catch(() => ({ ok: false, why: "Sign-in check failed." }));
    if (!auth.ok) return new Response(auth.why, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    const url = new URL(request.url);
    if (url.pathname === "/api/stats") {
      const days = Math.min(3650, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
      const data = await stats(env, days);
      return new Response(JSON.stringify({ ...data, email: auth.email }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  },
};
