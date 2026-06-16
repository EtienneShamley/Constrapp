import { useState, useEffect, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell } from "recharts";

const T = {
  bg:"#0B1629", sidebar:"#0D1B2A", surface:"#112336", card:"#162C42",
  cardHov:"#1A3350", input:"#0D1B2A", border:"#1E3248", borderLt:"#243D58",
  accent:"#00C9A7", accentDk:"#00A888", accentDim:"#00C9A715",
  green:"#00C9A7", amber:"#F59E0B", red:"#EF4444", blue:"#3B82F6", purple:"#8B5CF6",
  text:"#E8F0F7", textSoft:"#94A9BE", muted:"#546E84",
};

const SC = {
  "In Progress":  { bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Backlogged":   { bg:"#F59E0B20", tx:"#F59E0B", bd:"#F59E0B40" },
  "Planning":     { bg:"#3B82F620", tx:"#3B82F6", bd:"#3B82F640" },
  "Completed":    { bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Complete":     { bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Approved":     { bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Pending":      { bg:"#F59E0B20", tx:"#F59E0B", bd:"#F59E0B40" },
  "Sent":         { bg:"#3B82F620", tx:"#3B82F6", bd:"#3B82F640" },
  "Delivered":    { bg:"#8B5CF620", tx:"#8B5CF6", bd:"#8B5CF640" },
  "Rejected":     { bg:"#EF444420", tx:"#EF4444", bd:"#EF444440" },
  "Draft":        { bg:"#54688420", tx:"#546E84", bd:"#54688440" },
  "Current":      { bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Superseded":   { bg:"#54688420", tx:"#546E84", bd:"#54688440" },
  "Subcontractor":{ bg:"#00C9A720", tx:"#00C9A7", bd:"#00C9A740" },
  "Supplier":     { bg:"#3B82F620", tx:"#3B82F6", bd:"#3B82F640" },
  "Consultant":   { bg:"#8B5CF620", tx:"#8B5CF6", bd:"#8B5CF640" },
};

const COMPANIES = [
  { id:"c1", name:"Apex Builders",       color:"#00C9A7" },
  { id:"c2", name:"Summit Construction", color:"#3B82F6" },
  { id:"c3", name:"JP Group",            color:"#8B5CF6" },
];

const USERS = {
  c1:[
    { id:"u1", name:"JP Richards",    role:"super_admin",     email:"jp@constrapp.com",   pw:"admin123", av:"JP" },
    { id:"u2", name:"Sarah Mitchell", role:"company_admin",   email:"sarah@apex.com",      pw:"demo",     av:"SM" },
    { id:"u3", name:"Tom Walsh",      role:"project_manager", email:"tom@apex.com",        pw:"demo",     av:"TW" },
    { id:"u4", name:"Linda Chen",     role:"qs",              email:"linda@apex.com",      pw:"demo",     av:"LC" },
    { id:"u5", name:"Mark Davis",     role:"subcontractor",   email:"mark@subbies.com",    pw:"demo",     av:"MD" },
    { id:"u6", name:"Client Corp",    role:"client",          email:"client@corp.com",     pw:"demo",     av:"CC" },
  ],
  c2:[
    { id:"u7", name:"Jake Monroe",    role:"company_admin",   email:"jake@summit.com",     pw:"demo",     av:"JM" },
  ],
};

const DEMO_ACCOUNTS = [
  { email:"jp@constrapp.com",  pw:"admin123", label:"Super Admin — Platform Owner", role:"super_admin"    },
  { email:"sarah@apex.com",    pw:"demo",     label:"Company Admin",                role:"company_admin"  },
  { email:"tom@apex.com",      pw:"demo",     label:"Project Manager",              role:"project_manager"},
  { email:"linda@apex.com",    pw:"demo",     label:"QS / Office",                  role:"qs"             },
  { email:"mark@subbies.com",  pw:"demo",     label:"Subcontractor",                role:"subcontractor"  },
  { email:"client@corp.com",   pw:"demo",     label:"Client View",                  role:"client"         },
];

const ROLE_LABELS = {
  super_admin:"Super Admin", company_admin:"Company Admin",
  project_manager:"Project Manager", qs:"QS / Office",
  subcontractor:"Subcontractor", client:"Client",
};

const ROLE_NAV = {
  super_admin:     ["dashboard","projects","boq","budgets","forecasting","contacts","drawings","purchase_orders","qs_takeoff","subcontractors","pulse","shield","timeline","photos","reports","billing"],
  company_admin:   ["dashboard","projects","boq","budgets","forecasting","contacts","drawings","purchase_orders","qs_takeoff","subcontractors","pulse","shield","timeline","photos","reports","billing"],
  project_manager: ["dashboard","projects","budgets","contacts","drawings","purchase_orders","subcontractors","timeline","photos","reports"],
  qs:              ["dashboard","projects","boq","budgets","qs_takeoff","forecasting","reports"],
  subcontractor:   ["dashboard","projects","photos","drawings","purchase_orders"],
  client:          ["dashboard","projects","pulse","timeline","photos","reports"],
};

const PROJECTS = {
  c1:[
    { id:"p1", name:"Lakeside Apartments",      status:"In Progress", budget:3903006, spent:1328000, revenue:4200000, start:"01/09/2023", tasks:24, done:16, manager:"Tom Walsh",      location:"Brisbane QLD",  pct:67 },
    { id:"p2", name:"Westfield Office Tower",   status:"Backlogged",  budget:9700000, spent:2100000, revenue:10500000,start:"01/09/2023", tasks:30, done:8,  manager:"Tom Walsh",      location:"Sydney NSW",    pct:27 },
    { id:"p3", name:"Greenview Retail Complex", status:"In Progress", budget:1056000, spent:720000,  revenue:1150000, start:"01/03/2023", tasks:18, done:14, manager:"Sarah Mitchell", location:"Melbourne VIC", pct:78 },
    { id:"p4", name:"Sunset Villas",            status:"In Progress", budget:1050000, spent:312000,  revenue:1150000, start:"01/07/2023", tasks:40, done:11, manager:"Tom Walsh",      location:"Gold Coast QLD",pct:28 },
  ],
  c2:[
    { id:"p5", name:"North Shore Residential",  status:"In Progress", budget:4200000, spent:1900000, revenue:4600000, start:"15/06/2023", tasks:28, done:16, manager:"Jake Monroe",     location:"Sydney NSW",   pct:57 },
  ],
};

const CASHFLOW = [
  { m:"Sep 23", income:0,      expense:85000  },
  { m:"Oct 23", income:200000, expense:142000 },
  { m:"Nov 23", income:180000, expense:165000 },
  { m:"Dec 23", income:120000, expense:88000  },
  { m:"Jan 24", income:220000, expense:195000 },
  { m:"Feb 24", income:250000, expense:210000 },
  { m:"Mar 24", income:280000, expense:245000 },
  { m:"Apr 24", income:310000, expense:268000 },
  { m:"May 24", income:290000, expense:220000 },
  { m:"Jun 24", income:340000, expense:285000 },
];

const CHART_DATA = [
  { mo:"Jan", budget:280, actual:210, forecast:310 },
  { mo:"Feb", budget:300, actual:280, forecast:320 },
  { mo:"Mar", budget:320, actual:290, forecast:330 },
  { mo:"Apr", budget:310, actual:305, forecast:340 },
  { mo:"May", budget:350, actual:320, forecast:345 },
  { mo:"Jun", budget:380, actual:355, forecast:370 },
];

const DONUT = [
  { name:"Completed",  v:34, color:"#00C9A7" },
  { name:"In Progress",v:41, color:"#3B82F6"  },
  { name:"Pending",    v:25, color:"#EF4444"  },
];

const MEMBERSHIP = [
  { id:"starter",    name:"Starter",      price:1000, users:8,   color:"#546E84", popular:false,
    features:["8 user accounts","All core modules","Projects & Budgets","Email support"] },
  { id:"pro",        name:"Professional", price:1500, users:15,  color:"#00C9A7", popular:true,
    features:["15 user accounts","Everything in Starter","Constrapp IQ™ AI","QS Takeoff & BOQ","Constrapp PULSE™","Priority support"] },
  { id:"business",   name:"Business",     price:2000, users:22,  color:"#3B82F6", popular:false,
    features:["22 user accounts","Everything in Pro","Forecasting & Cashflow","API access","Dedicated support"] },
  { id:"enterprise", name:"Enterprise",   price:0,    users:999, color:"#F5A623", popular:false,
    features:["Unlimited users","Everything in Business","White-label option","SLA guarantee","Account manager"] },
];

const QS_ITEMS = [
  { id:"q1",  element:"Site Preparation", category:"Preliminaries", qty:1,     unit:"Item", rate:344000, cc:"1000" },
  { id:"q2",  element:"Concrete Slab L1", category:"Concrete",      qty:420,   unit:"m²",   rate:280,    cc:"2000" },
  { id:"q3",  element:"Concrete Slab L2", category:"Concrete",      qty:420,   unit:"m²",   rate:280,    cc:"2000" },
  { id:"q4",  element:"Concrete Slab L3", category:"Concrete",      qty:342,   unit:"m²",   rate:310,    cc:"2000" },
  { id:"q5",  element:"Reinforcing Steel",category:"Concrete",      qty:28000, unit:"kg",   rate:2.4,    cc:"2000" },
  { id:"q6",  element:"External Framing", category:"Framing",       qty:124,   unit:"lm",   rate:185,    cc:"3000" },
  { id:"q7",  element:"Internal Framing", category:"Framing",       qty:186,   unit:"lm",   rate:95,     cc:"3000" },
  { id:"q8",  element:"Roof Sheeting",    category:"Roofing",       qty:380,   unit:"m²",   rate:420,    cc:"4000" },
  { id:"q9",  element:"FC Cladding",      category:"Cladding",      qty:1240,  unit:"m²",   rate:85,     cc:"5000" },
  { id:"q10", element:"Doors",            category:"Joinery",       qty:28,    unit:"each", rate:1200,   cc:"6000" },
  { id:"q11", element:"Windows DG",       category:"Joinery",       qty:34,    unit:"each", rate:2800,   cc:"6000" },
  { id:"q12", element:"Electrical",       category:"Services",      qty:1,     unit:"Item", rate:220000, cc:"7000" },
  { id:"q13", element:"Plumbing",         category:"Services",      qty:1,     unit:"Item", rate:180000, cc:"7000" },
];

const CONTACTS = {
  c1:[
    { id:"ct1", name:"Mike Johnson",  co:"Precision Electrical", phone:"0412 345 678", email:"mike@precisionelec.com.au",  trade:"Electrical",   abn:"12 345 678 901", addr:"15 Trade St, Brisbane QLD",  notes:"Preferred electrician", tags:["Subcontractor"] },
    { id:"ct2", name:"Dave Smith",    co:"ProPlumb QLD",          phone:"0423 456 789", email:"dave@proplumb.com.au",       trade:"Plumbing",      abn:"23 456 789 012", addr:"8 Pipe Lane, Brisbane QLD",   notes:"",                      tags:["Subcontractor"] },
    { id:"ct3", name:"Sandra Lee",    co:"Lee Architecture",      phone:"0434 567 890", email:"sandra@leearch.com.au",      trade:"Architecture",  abn:"34 567 890 123", addr:"120 Queen St, Brisbane QLD",  notes:"Lead architect",        tags:["Consultant"]    },
    { id:"ct4", name:"Peter Nguyen",  co:"ABC Concrete Supplies", phone:"0445 678 901", email:"peter@abcconcrete.com.au",   trade:"Concrete",      abn:"45 678 901 234", addr:"2 Industrial Ave, Rocklea",   notes:"Preferred supplier",    tags:["Supplier"]      },
  ],
};

const $ = (n) => "$" + Math.round(n||0).toLocaleString("en-AU");
const $K = (n) => n>=1000000 ? "$"+(n/1000000).toFixed(1)+"M" : n>=1000 ? "$"+(n/1000).toFixed(0)+"K" : "$"+Math.round(n);
const pc = (a,b) => b ? Math.round(a/b*100) : 0;



// ─── UI PRIMITIVES ─────────────────────────────────────────────────────────────
const Logo = () => (
  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
    <path d="M28 8L16 20L28 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M20 8L8 20L20 32" stroke="#00C9A7" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.45"/>
  </svg>
);

const Badge = ({ status, small }) => {
  const s = SC[status] || { bg:"#54688420", tx:"#546E84", bd:"#54688440" };
  const pad = small ? "2px 8px" : "3px 10px";
  const fs = small ? 11 : 12;
  return (
    <span style={{ background:s.bg, color:s.tx, border:"1px solid "+s.bd, borderRadius:6, padding:pad, fontSize:fs, fontWeight:700, whiteSpace:"nowrap" }}>
      {status}
    </span>
  );
};

const ProgBar = ({ val, color, h }) => (
  <div style={{ height:h||5, background:T.border, borderRadius:99, overflow:"hidden" }}>
    <div style={{ height:"100%", width:Math.min(val||0,100)+"%", background:color||T.accent, borderRadius:99 }} />
  </div>
);

const Card = ({ children, style, onClick }) => (
  <div onClick={onClick}
    style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20, cursor:onClick?"pointer":"default", transition:"background .15s", ...style }}
    onMouseEnter={e => { if(onClick) e.currentTarget.style.background=T.cardHov; }}
    onMouseLeave={e => { if(onClick) e.currentTarget.style.background=T.surface; }}>
    {children}
  </div>
);

const Btn = ({ children, onClick, variant, sm, style, disabled }) => {
  const v = variant || "primary";
  let bs = {};
  if(v==="primary")  bs = { background:"linear-gradient(90deg,#00C9A7,#00A888)", color:"#000", border:"none" };
  if(v==="ghost")    bs = { background:"transparent", color:T.textSoft, border:"1px solid "+T.border };
  if(v==="success")  bs = { background:"#00C9A718", color:T.accent, border:"1px solid #00C9A740" };
  if(v==="danger")   bs = { background:"#EF444418", color:"#EF4444", border:"1px solid #EF444440" };
  if(v==="gold")     bs = { background:"linear-gradient(90deg,#F5A623,#D4880A)", color:"#000", border:"none" };
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ ...bs, borderRadius:8, padding:sm?"5px 12px":"8px 18px", fontSize:sm?11:13, fontWeight:700, cursor:disabled?"not-allowed":"pointer", fontFamily:"inherit", display:"inline-flex", alignItems:"center", gap:6, opacity:disabled?.5:1, transition:"opacity .15s", ...style }}
      onMouseEnter={e => { if(!disabled) e.currentTarget.style.opacity=".82"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity="1"; }}>
      {children}
    </button>
  );
};

const Field = ({ label, value, onChange, placeholder, type }) => (
  <div>
    {label && <label style={{ display:"block", color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginBottom:5 }}>{label}</label>}
    <input type={type||"text"} value={value||""} onChange={onChange} placeholder={placeholder}
      style={{ width:"100%", background:T.input, border:"1px solid "+T.border, borderRadius:8, padding:"9px 12px", color:T.text, fontSize:13, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }}
      onFocus={e => e.target.style.borderColor="#00C9A7"}
      onBlur={e => e.target.style.borderColor=T.border} />
  </div>
);

const Head = ({ title, sub, action }) => (
  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:22 }}>
    <div>
      <h2 style={{ color:T.text, fontSize:20, fontWeight:800, margin:0 }}>{title}</h2>
      {sub && <p style={{ color:T.muted, fontSize:13, margin:"4px 0 0" }}>{sub}</p>}
    </div>
    {action}
  </div>
);

const Stat = ({ label, value, sub, icon, color }) => (
  <Card style={{ position:"relative", overflow:"hidden" }}>
    <div style={{ position:"absolute", top:0, right:0, width:60, height:60, background:(color||T.accent)+"0A", borderRadius:"0 12px 0 60px" }} />
    <div style={{ fontSize:22, marginBottom:8 }}>{icon}</div>
    <p style={{ color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", margin:"0 0 4px" }}>{label}</p>
    <p style={{ color:color||T.text, fontSize:26, fontWeight:900, margin:0 }}>{value}</p>
    {sub && <p style={{ color:T.muted, fontSize:11, margin:"4px 0 0" }}>{sub}</p>}
  </Card>
);

const Tip = ({ active, payload, label }) => {
  if(!active||!payload?.length) return null;
  return (
    <div style={{ background:T.card, border:"1px solid "+T.border, borderRadius:8, padding:"8px 12px", fontSize:11 }}>
      <p style={{ color:T.muted, margin:"0 0 4px", fontWeight:700 }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ color:p.color||T.text, margin:"2px 0", fontWeight:600 }}>
          {p.name}: {typeof p.value==="number"&&p.value>999 ? $K(p.value) : p.value}
        </p>
      ))}
    </div>
  );
};

// ─── MEMBERSHIP ─────────────────────────────────────────────────────────────────
function MembershipPage({ onBack }) {
  const [sel,  setSel]  = useState("pro");
  const [extra,setExtra]= useState(0);
  const [code, setCode] = useState("");
  const [discPct,  setDiscPct]  = useState(0);
  const [applied, setApplied]   = useState(false);
  const [form, setForm] = useState({ firstName:"", lastName:"", company:"", abn:"", email:"", phone:"" });
  const CODES = { CONSTRAPP20:20, LAUNCH2024:15, BUILDER10:10 };

  const plan    = MEMBERSHIP.find(p => p.id===sel);
  const base    = plan ? plan.price : 0;
  const extraAmt= extra * 250;
  const sub     = base + extraAmt;
  const disc    = applied ? Math.round(sub * discPct / 100) : 0;
  const total   = sub - disc;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, fontFamily:"'Sora','DM Sans',sans-serif", overflowY:"auto" }}>
      <div style={{ background:T.sidebar, borderBottom:"1px solid "+T.border, padding:"16px 40px", display:"flex", alignItems:"center", gap:14 }}>
        <button onClick={onBack} style={{ background:"transparent", border:"1px solid "+T.border, color:T.muted, cursor:"pointer", fontSize:12, fontFamily:"inherit", padding:"5px 12px", borderRadius:7 }}>← Back</button>
        <Logo />
        <span style={{ fontSize:17, fontWeight:900, color:T.text }}>Constrapp</span>
      </div>
      <div style={{ maxWidth:1040, margin:"0 auto", padding:"50px 24px" }}>
        <div style={{ textAlign:"center", marginBottom:44 }}>
          <h1 style={{ color:T.text, fontSize:28, fontWeight:900, margin:"0 0 10px" }}>Choose Your Plan</h1>
          <p style={{ color:T.muted, fontSize:14 }}>Annual membership · AUD · Includes GST · Cancel anytime</p>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:16, marginBottom:36 }}>
          {MEMBERSHIP.map(p => (
            <div key={p.id} onClick={() => p.price>0 && setSel(p.id)}
              style={{ background:T.surface, border:"2px solid "+(sel===p.id ? p.color : T.border), borderRadius:14, padding:22, cursor:p.price>0?"pointer":"default", position:"relative", transition:"all .2s" }}>
              {p.popular && (
                <div style={{ position:"absolute", top:-12, left:"50%", transform:"translateX(-50%)", background:"#00C9A7", color:"#000", fontSize:10, fontWeight:900, padding:"3px 14px", borderRadius:99, whiteSpace:"nowrap" }}>
                  MOST POPULAR
                </div>
              )}
              <h3 style={{ color:p.color, fontWeight:900, margin:"0 0 8px", fontSize:15 }}>{p.name}</h3>
              {p.price > 0 ? (
                <>
                  <p style={{ color:T.text, fontSize:28, fontWeight:900, margin:"0 0 2px" }}>${p.price.toLocaleString()}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:"0 0 14px" }}>AUD/year · {p.users} users</p>
                </>
              ) : (
                <p style={{ color:T.text, fontSize:16, fontWeight:700, margin:"0 0 14px" }}>Contact Us</p>
              )}
              {p.features.map(f => (
                <div key={f} style={{ display:"flex", gap:7, marginBottom:7 }}>
                  <span style={{ color:p.color, fontSize:12, flexShrink:0 }}>✓</span>
                  <span style={{ color:T.textSoft, fontSize:12 }}>{f}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 320px", gap:18 }}>
          <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:14, padding:26 }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 20px", fontSize:15 }}>Customise & Checkout</h3>
            <div style={{ marginBottom:20 }}>
              <label style={{ display:"block", color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginBottom:8 }}>Extra Users — $250 AUD / user / year</label>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <button onClick={() => setExtra(Math.max(0,extra-1))} style={{ width:34, height:34, borderRadius:8, background:T.input, border:"1px solid "+T.border, color:T.text, fontSize:18, cursor:"pointer", fontFamily:"inherit" }}>−</button>
                <span style={{ color:T.text, fontSize:18, fontWeight:900, minWidth:28, textAlign:"center" }}>{extra}</span>
                <button onClick={() => setExtra(extra+1)} style={{ width:34, height:34, borderRadius:8, background:T.input, border:"1px solid "+T.border, color:T.text, fontSize:18, cursor:"pointer", fontFamily:"inherit" }}>+</button>
                <span style={{ color:T.muted, fontSize:12 }}>{(plan ? plan.users : 0)+extra} total users</span>
              </div>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ display:"block", color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginBottom:6 }}>Discount Code</label>
              <div style={{ display:"flex", gap:8 }}>
                <input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. CONSTRAPP20"
                  style={{ flex:1, background:T.input, border:"1px solid "+(applied ? T.accent : T.border), borderRadius:8, padding:"9px 12px", color:T.text, fontSize:13, fontFamily:"inherit", outline:"none" }} />
                <Btn onClick={() => {
                  const k = code.trim().toUpperCase();
                  if(CODES[k]) { setDiscPct(CODES[k]); setApplied(true); }
                  else alert("Invalid code. Try: CONSTRAPP20");
                }} variant="primary" sm>{applied ? "✓ Applied" : "Apply"}</Btn>
              </div>
              {applied && <p style={{ color:T.accent, fontSize:12, fontWeight:600, marginTop:5 }}>✓ {discPct}% discount applied!</p>}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {[["firstName","First Name"],["lastName","Last Name"],["company","Company Name"],["abn","ABN"],["email","Email"],["phone","Phone"]].map(([k,l]) => (
                <Field key={k} label={l} value={form[k]} onChange={e => setForm({...form,[k]:e.target.value})} />
              ))}
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:14, padding:22 }}>
              <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>Order Summary</h3>
              <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid "+T.border }}>
                <span style={{ color:T.muted, fontSize:12 }}>{plan ? plan.name : ""} Plan</span>
                <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>${base.toLocaleString()}</span>
              </div>
              {extra > 0 && (
                <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid "+T.border }}>
                  <span style={{ color:T.muted, fontSize:12 }}>{extra} extra users</span>
                  <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>${extraAmt.toLocaleString()}</span>
                </div>
              )}
              {applied && (
                <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid "+T.border }}>
                  <span style={{ color:T.muted, fontSize:12 }}>Discount ({discPct}%)</span>
                  <span style={{ color:T.accent, fontSize:13, fontWeight:600 }}>−${disc.toLocaleString()}</span>
                </div>
              )}
              <div style={{ display:"flex", justifyContent:"space-between", padding:"14px 0 4px" }}>
                <span style={{ color:T.text, fontSize:14, fontWeight:700 }}>Total AUD/year</span>
                <span style={{ color:"#F5A623", fontSize:22, fontWeight:900 }}>${total.toLocaleString()}</span>
              </div>
            </div>
            <Btn style={{ width:"100%", justifyContent:"center", padding:13, fontSize:14, borderRadius:10 }}>🔒 Proceed to Payment</Btn>
            <p style={{ color:T.muted, fontSize:11, textAlign:"center", lineHeight:1.6 }}>Payments via Stripe · SSL encrypted · 🇦🇺 Australian owned · ABN 78 901 234 567</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DEMO SITE ──────────────────────────────────────────────────────────────────
function DemoSite({ onLogin, onBack }) {
  return (
    <div style={{ minHeight:"100vh", background:T.bg, fontFamily:"'Sora','DM Sans',sans-serif" }}>
      <div style={{ background:T.sidebar, borderBottom:"1px solid "+T.border, padding:"16px 40px", display:"flex", alignItems:"center", gap:14 }}>
        <button onClick={onBack} style={{ background:"transparent", border:"1px solid "+T.border, color:T.muted, cursor:"pointer", fontSize:12, fontFamily:"inherit", padding:"5px 12px", borderRadius:7 }}>← Back</button>
        <Logo />
        <span style={{ fontSize:17, fontWeight:900, color:T.text }}>Constrapp — Demo</span>
      </div>
      <div style={{ maxWidth:820, margin:"0 auto", padding:"60px 24px" }}>
        <div style={{ textAlign:"center", marginBottom:36 }}>
          <h1 style={{ color:T.text, fontSize:26, fontWeight:900, margin:"0 0 10px" }}>Explore Constrapp Free</h1>
          <p style={{ color:T.muted, fontSize:14 }}>Click any role to enter. No credit card required.</p>
        </div>
        <div style={{ background:T.surface, border:"1px solid #00C9A740", borderRadius:12, padding:22, marginBottom:26 }}>
          <h3 style={{ color:T.accent, fontWeight:800, margin:"0 0 12px", fontSize:14 }}>🚀 Everything included</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            {["✅ Dashboard with live financial charts","✅ Projects, Budgets & BOQ Tender Tool","✅ AI QS Takeoff — Constrapp Quant™","✅ Constrapp PULSE™ project heartbeat","✅ Cashflow Forecasting & Profit analysis","✅ Contacts, Drawings & Markups","✅ Purchase Orders & Reports","✅ 6 role types to explore"].map(f => (
              <p key={f} style={{ color:T.textSoft, fontSize:12, margin:0, lineHeight:1.6 }}>{f}</p>
            ))}
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          {DEMO_ACCOUNTS.map(a => {
            const u = Object.values(USERS).flat().find(x => x.email===a.email);
            return (
              <div key={a.email} onClick={() => u && onLogin(u, COMPANIES[0])}
                style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:16, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center", transition:"all .18s" }}
                onMouseEnter={e => { e.currentTarget.style.background=T.card; e.currentTarget.style.borderColor="#00C9A760"; }}
                onMouseLeave={e => { e.currentTarget.style.background=T.surface; e.currentTarget.style.borderColor=T.border; }}>
                <div>
                  <p style={{ color:T.text, fontSize:13, fontWeight:700, margin:0 }}>{a.label}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:"3px 0 0" }}>{a.email}</p>
                </div>
                <Btn sm>Enter →</Btn>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── LOGIN ──────────────────────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [email,   setEmail]   = useState("");
  const [pass,    setPass]    = useState("");
  const [err,     setErr]     = useState("");
  const [loading, setLoading] = useState(false);
  const [view,    setView]    = useState("login");

  function tryLogin() {
    setLoading(true); setErr("");
    setTimeout(() => {
      const allUsers = Object.entries(USERS);
      for(let i=0; i<allUsers.length; i++) {
        const [cid, list] = allUsers[i];
        const u = list.find(x => x.email===email && x.pw===pass);
        if(u) {
          onLogin(u, COMPANIES.find(c => c.id===cid));
          return;
        }
      }
      setErr("Invalid email or password. Use the quick-fill links below.");
      setLoading(false);
    }, 500);
  }

  if(view==="demo")       return <DemoSite      onLogin={onLogin} onBack={() => setView("login")} />;
  if(view==="membership") return <MembershipPage onBack={() => setView("login")} />;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, display:"flex", fontFamily:"'Sora','DM Sans',sans-serif" }}>

      {/* LEFT HERO */}
      <div style={{ flex:1, background:"linear-gradient(140deg,#050E18 0%,#091828 55%,#061220 100%)", display:"flex", flexDirection:"column", justifyContent:"center", padding:"70px 80px", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-150, right:-150, width:500, height:500, borderRadius:"50%", background:"#00C9A705", border:"1px solid #00C9A70E", pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:-100, left:-100, width:380, height:380, borderRadius:"50%", background:"#3B82F605", pointerEvents:"none" }} />

        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:50 }}>
          <Logo />
          <span style={{ fontSize:34, fontWeight:900, color:T.text, letterSpacing:"-1px" }}>Constrapp</span>
        </div>

        <h1 style={{ color:T.text, fontSize:40, fontWeight:900, margin:"0 0 18px", lineHeight:1.1 }}>
          Construction management,<br />
          <span style={{ color:"#00C9A7" }}>reimagined.</span>
        </h1>

        <p style={{ color:T.muted, fontSize:15, lineHeight:1.75, margin:"0 0 44px", maxWidth:480 }}>
          The only construction platform with a living project health engine. Constrapp PULSE™ delivers real-time site intelligence that no other app in the world can match.
        </p>

        <div style={{ display:"flex", flexDirection:"column", gap:16, marginBottom:44 }}>
          {[
            ["💓","Constrapp PULSE™","Living AI project heartbeat — world-first technology"],
            ["🧠","Constrapp IQ™","AI-powered timeline, variation & accountability intelligence"],
            ["📐","Constrapp Quant™","AI quantity takeoff directly from your drawing uploads"],
            ["📋","BOQ → Budget","Tender tool that transfers directly to project budget in one click"],
            ["📈","Cashflow Forecasting","Profit %, cashflow curves & budget forecasting built-in"],
          ].map(([icon,title,desc]) => (
            <div key={title} style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
              <div style={{ width:36, height:36, borderRadius:10, background:"#00C9A715", border:"1px solid #00C9A722", display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, flexShrink:0 }}>{icon}</div>
              <div style={{ paddingTop:2 }}>
                <p style={{ color:T.text, fontSize:14, fontWeight:700, margin:0 }}>{title}</p>
                <p style={{ color:T.muted, fontSize:12, margin:"2px 0 0", lineHeight:1.5 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding:"16px 20px", background:"#00C9A715", borderRadius:12, border:"1px solid #00C9A730", maxWidth:440 }}>
          <p style={{ color:"#00C9A7", fontSize:13, fontWeight:800, margin:"0 0 5px" }}>🇦🇺 100% Australian-Built & Owned</p>
          <p style={{ color:T.muted, fontSize:12, margin:0, lineHeight:1.6 }}>Fully original software. All features and technology are proprietary and patent-pending.</p>
        </div>
      </div>

      {/* RIGHT SIGN IN */}
      <div style={{ width:460, background:T.sidebar, display:"flex", flexDirection:"column", justifyContent:"center", padding:"60px 44px", borderLeft:"1px solid "+T.border, overflowY:"auto" }}>
        <h2 style={{ color:T.text, fontSize:24, fontWeight:900, margin:"0 0 5px" }}>Sign In</h2>
        <p style={{ color:T.muted, fontSize:13, margin:"0 0 28px" }}>Access your Constrapp workspace</p>

        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", color:T.textSoft, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginBottom:6 }}>Email</label>
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="your@company.com.au"
            style={{ width:"100%", background:T.input, border:"1px solid "+T.border, borderRadius:9, padding:"11px 14px", color:T.text, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }}
            onFocus={e => e.target.style.borderColor="#00C9A7"} onBlur={e => e.target.style.borderColor=T.border} />
        </div>

        <div style={{ marginBottom:10 }}>
          <label style={{ display:"block", color:T.textSoft, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginBottom:6 }}>Password</label>
          <input value={pass} onChange={e => setPass(e.target.value)} type="password" placeholder="••••••••"
            onKeyDown={e => e.key==="Enter" && tryLogin()}
            style={{ width:"100%", background:T.input, border:"1px solid "+T.border, borderRadius:9, padding:"11px 14px", color:T.text, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }}
            onFocus={e => e.target.style.borderColor="#00C9A7"} onBlur={e => e.target.style.borderColor=T.border} />
        </div>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, marginTop:8 }}>
          <label style={{ display:"flex", alignItems:"center", gap:7, color:T.muted, fontSize:12, cursor:"pointer" }}>
            <input type="checkbox" style={{ accentColor:"#00C9A7" }} /> Remember Me
          </label>
          <span style={{ color:"#00C9A7", fontSize:12, cursor:"pointer", fontWeight:500 }}>Forgot Password?</span>
        </div>

        {err && (
          <div style={{ background:"#EF444415", border:"1px solid #EF444445", color:"#EF4444", padding:"10px 14px", borderRadius:8, fontSize:12, marginBottom:16, lineHeight:1.5 }}>
            {err}
          </div>
        )}

        <Btn onClick={tryLogin} style={{ width:"100%", justifyContent:"center", padding:13, fontSize:14, borderRadius:9, marginBottom:20 }}>
          {loading ? "Signing in…" : "Login"}
        </Btn>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:22 }}>
          <button onClick={() => setView("demo")}
            style={{ background:"#00C9A715", border:"1px solid #00C9A744", borderRadius:11, padding:"13px 12px", cursor:"pointer", fontFamily:"inherit", textAlign:"left", transition:"all .18s" }}
            onMouseEnter={e => { e.currentTarget.style.background="#00C9A728"; }}
            onMouseLeave={e => { e.currentTarget.style.background="#00C9A715"; }}>
            <p style={{ color:"#00C9A7", fontSize:13, fontWeight:900, margin:0 }}>🚀 Try Demo</p>
            <p style={{ color:T.muted, fontSize:11, margin:"4px 0 0" }}>Free · no login needed</p>
          </button>
          <button onClick={() => setView("membership")}
            style={{ background:"#F5A62318", border:"1px solid #F5A62344", borderRadius:11, padding:"13px 12px", cursor:"pointer", fontFamily:"inherit", textAlign:"left", transition:"all .18s" }}
            onMouseEnter={e => { e.currentTarget.style.background="#F5A62328"; }}
            onMouseLeave={e => { e.currentTarget.style.background="#F5A62318"; }}>
            <p style={{ color:"#F5A623", fontSize:13, fontWeight:900, margin:0 }}>💳 Buy Membership</p>
            <p style={{ color:T.muted, fontSize:11, margin:"4px 0 0" }}>From $1,000 AUD/year</p>
          </button>
        </div>

        <div style={{ background:T.input, border:"1px solid "+T.border, borderRadius:11, padding:16 }}>
          <p style={{ color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".6px", margin:"0 0 10px", textAlign:"center" }}>
            Demo Site — For Testing Purposes Only
          </p>
          {DEMO_ACCOUNTS.map(a => (
            <div key={a.email} onClick={() => { setEmail(a.email); setPass(a.pw); }}
              style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 4px", borderBottom:"1px solid "+T.border, cursor:"pointer" }}
              onMouseEnter={e => e.currentTarget.style.background=T.card}
              onMouseLeave={e => e.currentTarget.style.background="transparent"}>
              <span style={{ color:T.textSoft, fontSize:12 }}>{a.label}</span>
              <span style={{ color:"#00C9A7", fontSize:10, fontWeight:700 }}>fill ↑</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ────────────────────────────────────────────────────────────────────
const NAV = [
  { id:"dashboard",       icon:"⊞", label:"Dashboard"        },
  { id:"projects",        icon:"🏗", label:"Projects"         },
  { id:"boq",             icon:"📋", label:"BOQ & Tender"     },
  { id:"budgets",         icon:"💰", label:"Budgets"           },
  { id:"forecasting",     icon:"📈", label:"Forecasting"      },
  { id:"contacts",        icon:"👤", label:"Contacts"         },
  { id:"drawings",        icon:"📐", label:"Drawings & Docs"  },
  { id:"purchase_orders", icon:"🛒", label:"Purchase Orders"  },
  { id:"qs_takeoff",      icon:"📏", label:"QS Takeoff"       },
  { id:"subcontractors",  icon:"👷", label:"Subcontractors"   },
  { id:"pulse",           icon:"💓", label:"Constrapp PULSE™" },
  { id:"shield",          icon:"🛡", label:"Constrapp SHIELD™"},
  { id:"timeline",        icon:"⏱", label:"Timeline"         },
  { id:"photos",          icon:"📷", label:"Photos"           },
  { id:"reports",         icon:"📊", label:"Reports"          },
  { id:"billing",         icon:"💳", label:"Billing"          },
];

function Sidebar({ page, onNav, user, company, onSwitchCo }) {
  const [coOpen, setCoOpen] = useState(false);
  const allowed = ROLE_NAV[user.role] || [];
  const items   = NAV.filter(n => allowed.includes(n.id));

  return (
    <div style={{ width:222, background:T.sidebar, borderRight:"1px solid "+T.border, display:"flex", flexDirection:"column", height:"100vh", position:"sticky", top:0, flexShrink:0 }}>
      <div style={{ padding:"18px 16px 14px", borderBottom:"1px solid "+T.border, display:"flex", alignItems:"center", gap:10 }}>
        <Logo />
        <span style={{ fontSize:17, fontWeight:900, color:T.text }}>Constrapp</span>
      </div>

      {(user.role==="super_admin"||user.role==="company_admin") && (
        <div style={{ padding:"10px 12px", borderBottom:"1px solid "+T.border, position:"relative" }}>
          <div onClick={() => setCoOpen(!coOpen)}
            style={{ display:"flex", alignItems:"center", gap:8, background:T.bg, border:"1px solid "+T.border, borderRadius:8, padding:"7px 10px", cursor:"pointer" }}>
            <div style={{ width:8, height:8, borderRadius:"50%", background:company.color }} />
            <span style={{ color:T.text, fontSize:11, fontWeight:600, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{company.name}</span>
            <span style={{ color:T.muted, fontSize:9 }}>▼</span>
          </div>
          {coOpen && (
            <div style={{ position:"absolute", left:12, right:12, top:"calc(100% + 2px)", background:T.card, border:"1px solid "+T.border, borderRadius:10, zIndex:300, overflow:"hidden" }}>
              {COMPANIES.map(c => (
                <div key={c.id} onClick={() => { onSwitchCo(c); setCoOpen(false); }}
                  style={{ padding:"9px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, borderBottom:"1px solid "+T.border }}
                  onMouseEnter={e => e.currentTarget.style.background=T.cardHov}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:c.color }} />
                  <span style={{ color:T.text, fontSize:12 }}>{c.name}</span>
                  {c.id===company.id && <span style={{ color:T.accent, fontSize:10, marginLeft:"auto" }}>✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <nav style={{ flex:1, padding:"8px", overflowY:"auto" }}>
        {items.map(item => {
          const active   = page===item.id;
          const isPulse  = item.id==="pulse";
          const isShield = item.id==="shield";
          const activeCol= isPulse ? "#FF6B9D" : isShield ? "#00D4FF" : T.accent;
          return (
            <div key={item.id} onClick={() => onNav(item.id)}
              style={{
                display:"flex", alignItems:"center", gap:9, padding:"8px 10px", borderRadius:8, marginBottom:2, cursor:"pointer",
                background: active ? (isPulse?"#FF6B9D18":isShield?"#00D4FF18":T.accentDim) : "transparent",
                borderLeft: active ? "3px solid "+activeCol : "3px solid transparent",
                color:      active ? activeCol : T.muted,
                fontWeight: active ? 700 : 400, fontSize:12.5, transition:"all .12s"
              }}
              onMouseEnter={e => { if(!active) e.currentTarget.style.background=T.surface; }}
              onMouseLeave={e => { if(!active) e.currentTarget.style.background="transparent"; }}>
              <span style={{ fontSize:14 }}>{item.icon}</span>
              <span style={{ flex:1 }}>{item.label}</span>
              {isPulse  && <span style={{ width:6, height:6, borderRadius:"50%", background:"#FF6B9D", animation:"pd 1s ease-in-out infinite" }} />}
              {isShield && <span style={{ width:6, height:6, borderRadius:"50%", background:"#00D4FF", animation:"pd 1.4s ease-in-out infinite" }} />}
            </div>
          );
        })}
      </nav>

      <div style={{ padding:"12px 14px", borderTop:"1px solid "+T.border, display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ width:32, height:32, borderRadius:"50%", background:"#00C9A715", border:"2px solid #00C9A744", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800, color:T.accent, flexShrink:0 }}>
          {user.av}
        </div>
        <div style={{ minWidth:0 }}>
          <p style={{ color:T.text, fontSize:11, fontWeight:700, margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{user.name}</p>
          <p style={{ color:T.accent, fontSize:9, margin:0 }}>{ROLE_LABELS[user.role]}</p>
        </div>
      </div>
    </div>
  );
}

// ─── TOP BAR ────────────────────────────────────────────────────────────────────
function TopBar({ user, company, page, onLogout }) {
  const label = (NAV.find(n => n.id===page)||{label:"Dashboard"}).label;
  const [notif, setNotif] = useState(false);

  return (
    <div style={{ height:56, background:T.sidebar, borderBottom:"1px solid "+T.border, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 24px", flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <div style={{ width:4, height:18, background:T.accent, borderRadius:99 }} />
        <h1 style={{ color:T.text, fontSize:15, fontWeight:800, margin:0 }}>{label}</h1>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <div style={{ background:T.bg, border:"1px solid "+T.border, borderRadius:8, padding:"6px 12px", display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ color:T.muted, fontSize:13 }}>🔍</span>
          <input placeholder="Search…" style={{ background:"transparent", border:"none", outline:"none", color:T.text, fontSize:12.5, width:130, fontFamily:"inherit" }} />
        </div>
        <div style={{ position:"relative" }}>
          <div onClick={() => setNotif(!notif)}
            style={{ width:36, height:36, background:T.bg, border:"1px solid "+T.border, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", position:"relative" }}>
            <span style={{ fontSize:16 }}>🔔</span>
            <div style={{ position:"absolute", top:6, right:6, width:8, height:8, background:T.red, borderRadius:"50%", border:"2px solid "+T.sidebar }} />
          </div>
          {notif && (
            <div style={{ position:"absolute", right:0, top:"110%", width:290, background:T.card, border:"1px solid "+T.border, borderRadius:12, zIndex:500, overflow:"hidden" }}>
              <div style={{ padding:"10px 14px", borderBottom:"1px solid "+T.border }}>
                <span style={{ color:T.text, fontWeight:700, fontSize:13 }}>Notifications</span>
              </div>
              {[
                { icon:"💓", msg:"PULSE™: Westfield schedule risk detected"           },
                { icon:"✅", msg:"VAR-001 Lakeside — approved by client"               },
                { icon:"📋", msg:"PO-003 sent to Timber World — awaiting acceptance"  },
                { icon:"🧠", msg:"IQ Alert: BOQ for Lakeside ready for review"        },
              ].map((n,i) => (
                <div key={i} style={{ padding:"10px 14px", borderBottom:"1px solid "+T.border, display:"flex", gap:10 }}>
                  <span style={{ fontSize:15 }}>{n.icon}</span>
                  <p style={{ color:T.textSoft, fontSize:11.5, margin:0, lineHeight:1.5 }}>{n.msg}</p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, background:T.bg, border:"1px solid "+T.border, borderRadius:20, padding:"4px 10px 4px 4px" }}>
          <div style={{ width:28, height:28, borderRadius:"50%", background:"#00C9A715", border:"2px solid #00C9A744", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:800, color:T.accent }}>
            {user.av}
          </div>
          <div>
            <p style={{ color:T.text, fontSize:11, fontWeight:700, margin:0 }}>{user.name}</p>
            <p style={{ color:T.muted, fontSize:9, margin:0 }}>{company.name}</p>
          </div>
          <div onClick={onLogout}
            style={{ width:24, height:24, borderRadius:6, background:T.surface, border:"1px solid "+T.border, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:11, color:T.muted, marginLeft:4 }}
            title="Sign out">↩</div>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ──────────────────────────────────────────────────────────────────
function Dashboard({ user, company }) {
  const projects = PROJECTS[company.id] || [];
  const active   = projects.filter(p => p.status==="In Progress").length;
  const totalB   = projects.reduce((a,p) => a+p.budget, 0);
  const totalS   = projects.reduce((a,p) => a+p.spent, 0);

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <div style={{ marginBottom:22 }}>
        <h2 style={{ color:T.text, fontSize:22, fontWeight:900, margin:0 }}>Welcome, {user.name} 👋</h2>
        <p style={{ color:T.muted, fontSize:13, marginTop:4 }}>{company.name} · {new Date().toLocaleDateString("en-AU",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14, marginBottom:22 }}>
        <Stat label="Active Projects"    value={active}               icon="🏗" sub={projects.length+" total"} />
        <Stat label="Pending POs"        value="5"                    icon="📋" />
        <Stat label="Budget Utilization" value={pc(totalS,totalB)+"%"}icon="💰" sub={$K(totalS)+" of "+$K(totalB)} />
        <Stat label="Upcoming Tasks"     value={projects.reduce((a,p)=>a+(p.tasks-p.done),0)} icon="⚡" color={T.amber} />
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 300px", gap:14, marginBottom:14 }}>
        <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:15 }}>Project Financial Overview</h3>
            <div style={{ display:"flex", gap:10 }}>
              {[["Budget",T.blue],["Actual",T.accent],["Forecast",T.amber]].map(([l,c]) => (
                <div key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <div style={{ width:10, height:10, borderRadius:2, background:c }} />
                  <span style={{ color:T.muted, fontSize:10 }}>{l}</span>
                </div>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={CHART_DATA} margin={{ top:4, right:4, left:0, bottom:0 }}>
              <XAxis dataKey="mo" tick={{ fill:T.muted, fontSize:10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill:T.muted, fontSize:10 }} axisLine={false} tickLine={false} unit="k" />
              <Tooltip content={<Tip />} />
              <Bar dataKey="budget"   fill={T.blue}  radius={[4,4,0,0]} name="Budget"   barSize={16} />
              <Bar dataKey="actual"   fill={T.accent} radius={[4,4,0,0]} name="Actual"   barSize={16} />
              <Bar dataKey="forecast" fill={T.amber}  radius={[4,4,0,0]} name="Forecast" barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20 }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 16px", fontSize:15 }}>Task Progress</h3>
          <div style={{ position:"relative", width:140, height:140, margin:"0 auto 14px" }}>
            <PieChart width={140} height={140}>
              <Pie data={DONUT} cx={65} cy={65} innerRadius={44} outerRadius={62} dataKey="v" strokeWidth={0}>
                {DONUT.map((d,i) => <Cell key={i} fill={d.color} />)}
              </Pie>
            </PieChart>
            <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column" }}>
              <span style={{ color:T.text, fontSize:24, fontWeight:900 }}>72%</span>
              <span style={{ color:T.muted, fontSize:10 }}>Complete</span>
            </div>
          </div>
          {DONUT.map(d => (
            <div key={d.name} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <div style={{ width:10, height:10, borderRadius:2, background:d.color }} />
                <span style={{ color:T.textSoft, fontSize:12 }}>{d.name}</span>
              </div>
              <span style={{ color:T.text, fontSize:12, fontWeight:700 }}>{d.v}%</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:15 }}>Active Projects</h3>
          <Btn sm>+ Add New Project</Btn>
        </div>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ borderBottom:"1px solid "+T.border }}>
              {["","Project Name","Status","Budget","Start Date","Actions"].map(h => (
                <th key={h} style={{ textAlign:"left", padding:"7px 12px", color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} style={{ borderBottom:"1px solid "+T.border }}
                onMouseEnter={e => e.currentTarget.style.background=T.card}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <td style={{ padding:"11px 6px 11px 12px" }}>
                  <div style={{ width:28, height:28, borderRadius:6, background:"#00C9A715", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12 }}>🏗</div>
                </td>
                <td style={{ padding:"11px 12px 11px 6px" }}>
                  <p style={{ color:T.text, fontSize:13, fontWeight:600, margin:0 }}>{p.name}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:"1px 0 0" }}>{p.location}</p>
                </td>
                <td style={{ padding:"11px 12px" }}><Badge status={p.status} small /></td>
                <td style={{ padding:"11px 12px", color:T.textSoft, fontSize:13, fontWeight:600 }}>${p.budget.toLocaleString()}</td>
                <td style={{ padding:"11px 12px", color:T.muted, fontSize:12 }}>{p.start}</td>
                <td style={{ padding:"11px 12px" }}><Btn variant="ghost" sm>View ▾</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── PROJECTS ───────────────────────────────────────────────────────────────────
function Projects({ company }) {
  const projects = PROJECTS[company.id] || [];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Projects" sub={projects.length+" projects · "+company.name}
        action={<Btn>+ Add New Project</Btn>} />
      <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, overflow:"hidden", marginBottom:16 }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:T.card, borderBottom:"1px solid "+T.border }}>
              {["","Project Name","Status","Budget","Start Date","Progress","Actions"].map(h => (
                <th key={h} style={{ textAlign:"left", padding:"10px 14px", color:T.muted, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} style={{ borderBottom:"1px solid "+T.border }}
                onMouseEnter={e => e.currentTarget.style.background=T.card}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <td style={{ padding:"12px 6px 12px 14px" }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:(SC[p.status]||{tx:T.muted}).tx }} />
                </td>
                <td style={{ padding:"12px 14px 12px 6px" }}>
                  <p style={{ color:T.text, fontSize:13, fontWeight:600, margin:0 }}>{p.name}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:"1px 0 0" }}>📍 {p.location}</p>
                </td>
                <td style={{ padding:"12px 14px" }}><Badge status={p.status} small /></td>
                <td style={{ padding:"12px 14px", color:T.text, fontSize:13, fontWeight:600 }}>${p.budget.toLocaleString()}</td>
                <td style={{ padding:"12px 14px", color:T.muted, fontSize:12 }}>{p.start}</td>
                <td style={{ padding:"12px 14px", minWidth:110 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <div style={{ flex:1 }}><ProgBar val={p.pct} /></div>
                    <span style={{ color:T.muted, fontSize:10 }}>{p.pct}%</span>
                  </div>
                </td>
                <td style={{ padding:"12px 14px" }}><Btn variant="ghost" sm>View ▾</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── BOQ ────────────────────────────────────────────────────────────────────────
function BOQ() {
  const [stage,  setStage]  = useState("build");
  const [items,  setItems]  = useState(QS_ITEMS.map(q => ({...q, inc:true, r:q.rate})));
  const [margin, setMargin] = useState(15);
  const [ohd,    setOhd]    = useState(8);

  const inc    = items.filter(i => i.inc);
  const cost   = inc.reduce((a,i) => a+(i.qty*i.r), 0);
  const oAmt   = cost*ohd/100;
  const pAmt   = (cost+oAmt)*margin/100;
  const tender = cost+oAmt+pAmt;
  const cats   = [...new Set(items.map(i => i.category))];

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Bill of Quantities — Tender Tool" sub="QS Takeoff → BOQ → Approve → Budget transfer"
        action={
          <div style={{ display:"flex", gap:8 }}>
            {stage==="build"    && <Btn onClick={() => setStage("review")}>Generate BOQ →</Btn>}
            {stage==="review"   && <Btn variant="success" onClick={() => setStage("approved")}>✓ Approve & Transfer</Btn>}
            {stage==="approved" && <Badge status="Approved" />}
            <Btn variant="ghost">⬇ Export</Btn>
          </div>
        } />

      <div style={{ display:"flex", marginBottom:20 }}>
        {[["📐 QS Takeoff","build"],["📋 BOQ Review","review"],["✅ Budget Transfer","approved"]].map(([lbl,s]) => {
          const order = ["build","review","approved"];
          const isActive = s===stage;
          const isDone   = order.indexOf(s)<order.indexOf(stage);
          return (
            <div key={s} style={{ flex:1, padding:"10px 14px", background:isActive?T.accentDim:isDone?"#00C9A710":T.surface, borderTop:"2px solid "+(isActive?T.accent:isDone?T.green:T.border), display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ color:isActive?T.accent:isDone?T.green:T.muted, fontSize:12, fontWeight:700 }}>{lbl}</span>
              {isDone && <span style={{ color:T.green }}>✓</span>}
            </div>
          );
        })}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 270px", gap:16 }}>
        <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, overflow:"hidden" }}>
          <div style={{ padding:"13px 18px", borderBottom:"1px solid "+T.border }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:13 }}>Bill of Quantities — Lakeside Apartments</h3>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ background:T.card }}>
                {["","Code","Element","Qty","Unit","Rate","Total"].map(h => (
                  <th key={h} style={{ textAlign:"left", padding:"8px 10px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", borderBottom:"1px solid "+T.border }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cats.map(cat => (
                <React.Fragment key={cat}>
                  <tr>
                    <td colSpan={7} style={{ padding:"7px 10px", color:T.accent, fontSize:11, fontWeight:800, textTransform:"uppercase", background:T.card+"88", borderBottom:"1px solid "+T.border }}>{cat}</td>
                  </tr>
                  {items.filter(i => i.category===cat).map(item => (
                    <tr key={item.id} style={{ borderBottom:"1px solid "+T.border, opacity:item.inc?1:.4 }}>
                      <td style={{ padding:"8px 10px" }}>
                        <input type="checkbox" checked={item.inc} onChange={e => setItems(items.map(i => i.id===item.id?{...i,inc:e.target.checked}:i))} style={{ accentColor:T.accent }} />
                      </td>
                      <td style={{ padding:"8px 10px", color:T.accent, fontWeight:700 }}>{item.cc}</td>
                      <td style={{ padding:"8px 10px", color:T.text }}>{item.element}</td>
                      <td style={{ padding:"8px 10px", color:T.text, textAlign:"right" }}>{item.qty.toLocaleString()}</td>
                      <td style={{ padding:"8px 10px", color:T.muted }}>{item.unit}</td>
                      <td style={{ padding:"8px 10px" }}>
                        <input type="number" value={item.r}
                          onChange={e => setItems(items.map(i => i.id===item.id?{...i,r:parseFloat(e.target.value)||0}:i))}
                          style={{ width:72, background:T.bg, border:"1px solid "+T.border, borderRadius:6, padding:"3px 6px", color:T.text, fontSize:12, fontFamily:"inherit", textAlign:"right", outline:"none" }} />
                      </td>
                      <td style={{ padding:"8px 10px", color:"#F5A623", fontWeight:700, textAlign:"right" }}>{$(item.qty*item.r)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <Card>
            <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Tender Summary</h3>
            {[{l:"Direct Cost",v:$(cost),c:T.textSoft},{l:"Overheads ("+ohd+"%)",v:$(oAmt),c:T.textSoft},{l:"Margin ("+margin+"%)",v:$(pAmt),c:T.green},{l:"TENDER PRICE",v:$(tender),c:"#F5A623",big:true}].map(r => (
              <div key={r.l} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid "+T.border }}>
                <span style={{ color:T.muted, fontSize:12 }}>{r.l}</span>
                <span style={{ color:r.c, fontSize:r.big?15:13, fontWeight:r.big?900:600 }}>{r.v}</span>
              </div>
            ))}
            <div style={{ marginTop:12 }}>
              <label style={{ color:T.muted, fontSize:10, fontWeight:700 }}>OVERHEADS {ohd}%</label>
              <input type="range" min={0} max={30} value={ohd} onChange={e => setOhd(+e.target.value)} style={{ width:"100%", accentColor:T.accent, margin:"4px 0 8px" }} />
              <label style={{ color:T.muted, fontSize:10, fontWeight:700 }}>MARGIN {margin}%</label>
              <input type="range" min={0} max={40} value={margin} onChange={e => setMargin(+e.target.value)} style={{ width:"100%", accentColor:"#F5A623", marginTop:4 }} />
            </div>
          </Card>
          <Card>
            <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 10px", fontSize:13 }}>Profit Analysis</h3>
            <div style={{ textAlign:"center" }}>
              <p style={{ color:T.green, fontSize:30, fontWeight:900, margin:0 }}>{margin}%</p>
              <p style={{ color:T.muted, fontSize:11, margin:"2px 0 6px" }}>Gross Margin</p>
              <p style={{ color:"#F5A623", fontSize:18, fontWeight:800, margin:0 }}>{$(pAmt)}</p>
              <p style={{ color:T.muted, fontSize:11, margin:"2px 0" }}>Profit $</p>
            </div>
          </Card>
          {stage==="approved" && (
            <Card style={{ background:"#00C9A710", border:"1px solid #00C9A744" }}>
              <p style={{ color:T.green, fontSize:13, fontWeight:700, margin:0 }}>✅ Transferred to Budget</p>
              <p style={{ color:T.muted, fontSize:11, marginTop:4 }}>{$(tender)} set as project budget.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FORECASTING ────────────────────────────────────────────────────────────────
function Forecasting({ company }) {
  const projects = PROJECTS[company.id] || [];
  const [selId, setSelId] = useState(projects.length > 0 ? projects[0].id : "");
  const p = projects.find(x => x.id===selId);
  if(!p) return <div style={{ padding:24, color:T.muted }}>No projects found.</div>;
  const profit  = p.revenue - p.budget;
  const profPct = (profit/p.revenue*100).toFixed(1);

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Forecasting & Cashflow" sub="Budget forecasting, cashflow and profit analysis" />
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {projects.map(x => (
          <button key={x.id} onClick={() => setSelId(x.id)}
            style={{ background:selId===x.id?T.accent:T.surface, color:selId===x.id?"#000":T.muted, border:"1px solid "+T.border, borderRadius:8, padding:"7px 14px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
            {x.name.split(" ").slice(0,2).join(" ")}
          </button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12, marginBottom:20 }}>
        <Stat label="Contract Value" value={$K(p.revenue)} icon="📄" color={T.blue} />
        <Stat label="Budget Cost"    value={$K(p.budget)}  icon="💰" />
        <Stat label="Gross Profit"   value={$K(profit)}    icon="💎" color={T.green} sub={profPct+"% margin"} />
        <Stat label="Forecast Profit" value={$K(profit*.92)} icon="🔮" color="#F5A623" sub="At completion" />
      </div>
      <Card style={{ marginBottom:14 }}>
        <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>Cashflow Over Build Period — {p.name}</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={CASHFLOW}>
            <defs>
              <linearGradient id="gi" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00C9A7" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#00C9A7" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="ge" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#EF4444" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#EF4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="m" tick={{ fill:T.muted, fontSize:9 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill:T.muted, fontSize:9 }} axisLine={false} tickLine={false} tickFormatter={v => "$"+v/1000+"k"} />
            <Tooltip content={<Tip />} />
            <Area type="monotone" dataKey="income"  stroke={T.accent} strokeWidth={2} fill="url(#gi)" name="Income"  />
            <Area type="monotone" dataKey="expense" stroke={T.red}    strokeWidth={2} fill="url(#ge)" name="Expense" />
          </AreaChart>
        </ResponsiveContainer>
      </Card>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <Card>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Profit Breakdown</h3>
          {[{l:"Contract Revenue",v:p.revenue,c:T.blue},{l:"Direct Costs",v:p.budget*.75,c:T.red},{l:"Overheads",v:p.budget*.15,c:T.amber},{l:"Gross Profit",v:profit,c:T.green}].map(r => (
            <div key={r.l} style={{ marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ color:T.textSoft, fontSize:12 }}>{r.l}</span>
                <span style={{ color:r.c, fontSize:13, fontWeight:700 }}>{$K(r.v)}</span>
              </div>
              <ProgBar val={pc(r.v,p.revenue)} color={r.c} h={4} />
            </div>
          ))}
          <div style={{ marginTop:12, padding:"10px 12px", background:"#00C9A710", borderRadius:8, display:"flex", justifyContent:"space-between" }}>
            <span style={{ color:T.green, fontSize:13, fontWeight:700 }}>Gross Profit</span>
            <span style={{ color:T.green, fontSize:15, fontWeight:900 }}>{profPct}% · {$K(profit)}</span>
          </div>
        </Card>
        <Card>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Cumulative Cashflow</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={CASHFLOW}>
              <XAxis dataKey="m" tick={{ fill:T.muted, fontSize:9 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill:T.muted, fontSize:9 }} axisLine={false} tickLine={false} tickFormatter={v => $K(v)} />
              <Tooltip content={<Tip />} />
              <Line type="monotone" dataKey="income"  stroke={T.accent} strokeWidth={2} dot={false} name="Income"  />
              <Line type="monotone" dataKey="expense" stroke={T.red}    strokeWidth={2} dot={false} name="Expense" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}

// ─── CONTACTS ───────────────────────────────────────────────────────────────────
function Contacts({ company }) {
  const [list, setList] = useState(CONTACTS[company.id] || []);
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
  const [newC, setNewC] = useState({ name:"", co:"", phone:"", email:"", trade:"", abn:"", addr:"", notes:"" });
  const tagCol = { Subcontractor:T.accent, Supplier:T.blue, Consultant:T.purple };
  const filtered = list.filter(c => [c.name,c.co,c.trade,c.email].some(f => f.toLowerCase().includes(q.toLowerCase())));
  const sel = list.find(c => c.id===selId);

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Contacts" sub={list.length+" contacts · send POs, subcontracts & messages"} action={<Btn onClick={() => setShowAdd(!showAdd)}>+ Add Contact</Btn>} />
      {showAdd && (
        <Card style={{ marginBottom:14, border:"1px solid #00C9A740" }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:13 }}>New Contact</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
            {Object.keys(newC).map(k => (
              <Field key={k} label={k} value={newC[k]} onChange={e => setNewC({...newC,[k]:e.target.value})} />
            ))}
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <Btn onClick={() => {
              if(!newC.name) return;
              setList([...list,{...newC,id:"ct"+Date.now(),tags:["Contact"]}]);
              setNewC({name:"",co:"",phone:"",email:"",trade:"",abn:"",addr:"",notes:""});
              setShowAdd(false);
            }}>Save Contact</Btn>
            <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
          </div>
        </Card>
      )}
      {showMsg && sel && (
        <Card style={{ marginBottom:14, border:"1px solid #3B82F640" }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Message · {sel.name}</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:10, marginBottom:10, alignItems:"end" }}>
            <Field label="Subject" placeholder="e.g. Subcontract for Lakeside Apartments" />
            <div style={{ display:"flex", gap:8 }}>
              <Btn sm>✉ Send</Btn>
              <Btn variant="ghost" sm>📋 PO</Btn>
              <Btn variant="ghost" sm>📄 Subcontract</Btn>
              <Btn variant="ghost" sm onClick={() => setShowMsg(false)}>✕</Btn>
            </div>
          </div>
          <textarea placeholder="Message…" style={{ width:"100%", background:T.input, border:"1px solid "+T.border, borderRadius:8, padding:10, color:T.text, fontSize:13, fontFamily:"inherit", resize:"vertical", minHeight:70, outline:"none", boxSizing:"border-box" }} />
        </Card>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"260px 1fr", gap:14 }}>
        <Card style={{ padding:0 }}>
          <div style={{ padding:12, borderBottom:"1px solid "+T.border }}>
            <input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)}
              style={{ width:"100%", background:T.input, border:"1px solid "+T.border, borderRadius:8, padding:"7px 10px", color:T.text, fontSize:12, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
          </div>
          {filtered.map(c => (
            <div key={c.id} onClick={() => setSelId(c.id)}
              style={{ padding:"11px 14px", borderBottom:"1px solid "+T.border, cursor:"pointer", background:selId===c.id?T.accentDim:"transparent", borderLeft:selId===c.id?"3px solid "+T.accent:"3px solid transparent" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:34, height:34, borderRadius:"50%", background:(tagCol[c.tags[0]]||T.muted)+"22", border:"2px solid "+(tagCol[c.tags[0]]||T.muted)+"44", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, color:tagCol[c.tags[0]]||T.muted, flexShrink:0 }}>{c.name[0]}</div>
                <div style={{ minWidth:0 }}>
                  <p style={{ color:T.text, fontSize:12, fontWeight:600, margin:0 }}>{c.name}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:"1px 0 0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.co}</p>
                </div>
              </div>
            </div>
          ))}
        </Card>
        {sel ? (
          <Card>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:18 }}>
              <div style={{ display:"flex", gap:14 }}>
                <div style={{ width:52, height:52, borderRadius:"50%", background:(tagCol[sel.tags[0]]||T.muted)+"22", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, fontWeight:800, color:tagCol[sel.tags[0]]||T.muted }}>{sel.name[0]}</div>
                <div>
                  <h2 style={{ color:T.text, fontSize:18, fontWeight:800, margin:0 }}>{sel.name}</h2>
                  <p style={{ color:T.textSoft, fontSize:13, margin:"3px 0 5px" }}>{sel.co}</p>
                  <Badge status={sel.tags[0]} small />
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <Btn sm onClick={() => setShowMsg(true)}>✉ Message</Btn>
                <Btn variant="ghost" sm>📋 Send PO</Btn>
                <Btn variant="ghost" sm>📄 Subcontract</Btn>
              </div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
              {[["📞 Phone",sel.phone],["✉ Email",sel.email],["🏢 Trade",sel.trade],["🔢 ABN",sel.abn],["📍 Address",sel.addr],["📝 Notes",sel.notes||"—"]].map(([l,v]) => (
                <div key={l}>
                  <p style={{ color:T.muted, fontSize:10, fontWeight:700, margin:"0 0 3px", textTransform:"uppercase", letterSpacing:".4px" }}>{l}</p>
                  <p style={{ color:T.text, fontSize:13, margin:0 }}>{v}</p>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card style={{ display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", opacity:.4 }}>
            <span style={{ fontSize:40, marginBottom:12 }}>👤</span>
            <p style={{ color:T.muted, fontSize:13 }}>Select a contact to view details</p>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── DRAWINGS ────────────────────────────────────────────────────────────────────
function Drawings() {
  const [tab, setTab] = useState("drawings");
  const [selId, setSelId] = useState(null);
  const [mkup, setMkup] = useState(false);
  const DRWS = [
    { id:"d1", name:"Architectural Floor Plans",       ref:"A-100", rev:"Rev C", disc:"Architecture", date:"15/10/2024", status:"Current",    pages:8,  by:"Sandra Lee"  },
    { id:"d2", name:"Structural General Arrangement",  ref:"S-100", rev:"Rev B", disc:"Structural",   date:"02/10/2024", status:"Current",    pages:12, by:"Tom Walsh"   },
    { id:"d3", name:"Electrical Layout L1",            ref:"E-101", rev:"Rev A", disc:"Electrical",   date:"28/09/2024", status:"Superseded", pages:4,  by:"Mike Johnson" },
    { id:"d4", name:"Electrical Layout L1",            ref:"E-101", rev:"Rev B", disc:"Electrical",   date:"18/10/2024", status:"Current",    pages:4,  by:"Mike Johnson" },
    { id:"d5", name:"Hydraulic Services Plan",         ref:"H-100", rev:"Rev A", disc:"Hydraulic",    date:"10/10/2024", status:"Current",    pages:6,  by:"Dave Smith"  },
  ];
  const dCol = { Architecture:T.accent, Structural:T.blue, Electrical:"#F5A623", Hydraulic:T.purple };
  const discs = [...new Set(DRWS.map(d => d.disc))];
  const sel   = DRWS.find(d => d.id===selId);

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Drawings & Documents" sub="Upload · revise · mark up · share"
        action={<div style={{ display:"flex", gap:8 }}><Btn variant="ghost">⬆ Upload</Btn><Btn>📄 Document</Btn></div>} />
      <div style={{ display:"flex", gap:0, marginBottom:18, borderBottom:"1px solid "+T.border }}>
        {["Drawings","Documents","Site Photos","Markups"].map(t => {
          const k = t.toLowerCase().replace(" ","_");
          const a = tab===k;
          return (
            <button key={t} onClick={() => setTab(k)}
              style={{ background:"transparent", border:"none", borderBottom:a?"2px solid "+T.accent:"2px solid transparent", color:a?T.accent:T.muted, fontWeight:a?700:400, fontSize:13, padding:"8px 18px", cursor:"pointer", fontFamily:"inherit", marginBottom:-1 }}>
              {t}
            </button>
          );
        })}
      </div>

      {tab==="drawings" && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 330px", gap:14 }}>
          <div>
            <div style={{ background:"#F59E0B18", border:"1px solid #F59E0B33", borderRadius:10, padding:"10px 14px", marginBottom:14, display:"flex", gap:10 }}>
              <span style={{ fontSize:16 }}>⚠️</span>
              <div>
                <p style={{ color:T.amber, fontSize:12, fontWeight:700, margin:0 }}>E-101 Superseded — Rev A replaced by Rev B (18/10/2024)</p>
                <p style={{ color:T.muted, fontSize:11, margin:0 }}>Ensure team members download the latest revision.</p>
              </div>
            </div>
            {discs.map(disc => (
              <div key={disc} style={{ marginBottom:16 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <div style={{ width:10, height:10, borderRadius:2, background:dCol[disc]||T.muted }} />
                  <span style={{ color:dCol[disc]||T.muted, fontSize:11, fontWeight:800, textTransform:"uppercase", letterSpacing:".5px" }}>{disc}</span>
                </div>
                {DRWS.filter(d => d.disc===disc).map(drw => (
                  <div key={drw.id} onClick={() => setSelId(drw.id)}
                    style={{ background:selId===drw.id?T.accentDim:T.bg, border:"1px solid "+(selId===drw.id?T.accent+"55":T.border), borderRadius:10, padding:"11px 14px", marginBottom:8, cursor:"pointer", display:"flex", alignItems:"center", gap:14, transition:"all .15s" }}>
                    <div style={{ width:38, height:48, background:(dCol[disc]||T.muted)+"22", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, fontSize:18 }}>📐</div>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:3 }}>
                        <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>{drw.name}</span>
                        <Badge status={drw.status} small />
                      </div>
                      <p style={{ color:T.muted, fontSize:11, margin:0 }}>{drw.ref} · {drw.rev} · {drw.pages} pages · {drw.date}</p>
                    </div>
                    <div style={{ display:"flex", gap:6 }}>
                      <Btn variant="ghost" sm>👁</Btn>
                      <Btn variant="ghost" sm>⬇</Btn>
                      <Btn sm onClick={e => { e.stopPropagation(); setSelId(drw.id); setMkup(true); }}>✏ Markup</Btn>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {sel ? (
            <Card style={{ padding:0, overflow:"hidden" }}>
              <div style={{ padding:"12px 14px", borderBottom:"1px solid "+T.border, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div>
                  <p style={{ color:T.text, fontSize:12, fontWeight:700, margin:0 }}>{sel.ref} · {sel.rev}</p>
                  <p style={{ color:T.muted, fontSize:10, margin:0 }}>{sel.name}</p>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <Btn sm onClick={() => setMkup(!mkup)}>✏ Markup</Btn>
                  <Btn variant="ghost" sm onClick={() => setSelId(null)}>✕</Btn>
                </div>
              </div>
              <div style={{ height:330, background:"#060E18", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", position:"relative", overflow:"hidden" }}>
                <svg width="100%" height="100%" style={{ position:"absolute", opacity:.08 }}>
                  {[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map(i => (
                    <line key={"h"+i} x1="0" y1={i*22} x2="100%" y2={i*22} stroke="#00C9A7" strokeWidth=".5" />
                  ))}
                  {[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25].map(i => (
                    <line key={"v"+i} x1={i*22} y1="0" x2={i*22} y2="100%" stroke="#00C9A7" strokeWidth=".5" />
                  ))}
                </svg>
                <svg width="260" height="200" style={{ opacity:.8 }}>
                  <rect x="20" y="20" width="220" height="160" stroke="#00C9A7" strokeWidth="2" fill="none"/>
                  <rect x="40" y="40" width="80" height="60" stroke="#94A9BE" strokeWidth="1.5" fill="none"/>
                  <rect x="140" y="40" width="80" height="60" stroke="#94A9BE" strokeWidth="1.5" fill="none"/>
                  <rect x="40" y="120" width="180" height="40" stroke="#94A9BE" strokeWidth="1.5" fill="none"/>
                  <line x1="20" y1="110" x2="240" y2="110" stroke="#546E84" strokeWidth="1" strokeDasharray="5 3"/>
                  <circle cx="80" cy="70" r="8" stroke="#00C9A7" strokeWidth="1.5" fill="none"/>
                  <circle cx="180" cy="70" r="8" stroke="#00C9A7" strokeWidth="1.5" fill="none"/>
                  {mkup && (
                    <>
                      <circle cx="120" cy="50" r="12" stroke="#EF4444" strokeWidth="2" fill="none"/>
                      <text x="110" y="43" fill="#EF4444" fontSize="9">RFI</text>
                      <rect x="50" y="125" width="40" height="25" stroke="#F59E0B" strokeWidth="2" fill="#F59E0B22" strokeDasharray="3 2"/>
                      <text x="52" y="140" fill="#F59E0B" fontSize="8">CHECK</text>
                    </>
                  )}
                </svg>
                {mkup && (
                  <div style={{ position:"absolute", top:10, left:10, background:T.card+"EE", borderRadius:8, padding:8, display:"flex", gap:5, flexDirection:"column" }}>
                    {["✏ Draw","⭕ Circle","□ Box","T Text","📍 Pin"].map(tool => (
                      <button key={tool} style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:6, padding:"4px 8px", color:T.text, fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>{tool}</button>
                    ))}
                  </div>
                )}
                <p style={{ color:T.muted, fontSize:10, position:"absolute", bottom:10 }}>{sel.ref} · {sel.rev} · Page 1 of {sel.pages}</p>
              </div>
              {mkup && (
                <div style={{ padding:"10px 14px", borderTop:"1px solid "+T.border, display:"flex", gap:8 }}>
                  <Btn variant="success" sm>💾 Save</Btn>
                  <Btn variant="ghost" sm>📤 Share</Btn>
                  <Btn variant="danger" sm onClick={() => setMkup(false)}>Discard</Btn>
                </div>
              )}
            </Card>
          ) : (
            <Card style={{ display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", opacity:.4 }}>
              <span style={{ fontSize:44, marginBottom:12 }}>📐</span>
              <p style={{ color:T.muted, fontSize:13 }}>Select a drawing to preview</p>
            </Card>
          )}
        </div>
      )}

      {tab==="documents" && (
        <Card>
          {[
            { icon:"📋", name:"Head Contract - Lakeside Apartments.pdf", type:"Contract",     date:"01/09/2023", size:"2.4 MB" },
            { icon:"⚠️", name:"Site Safety Management Plan.pdf",          type:"Safety",       date:"15/09/2023", size:"1.8 MB" },
            { icon:"📄", name:"Specification - Division 03 Concrete.pdf", type:"Specification",date:"20/08/2023", size:"4.1 MB" },
            { icon:"📝", name:"Subcontract - Precision Electrical.pdf",    type:"Subcontract",  date:"10/10/2023", size:"890 KB" },
          ].map((doc,i) => (
            <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0", borderBottom:"1px solid "+T.border }}>
              <div style={{ display:"flex", gap:12 }}>
                <span style={{ fontSize:22 }}>{doc.icon}</span>
                <div>
                  <p style={{ color:T.text, fontSize:13, fontWeight:500, margin:0 }}>{doc.name}</p>
                  <p style={{ color:T.muted, fontSize:11, margin:0 }}>{doc.type} · {doc.date} · {doc.size}</p>
                </div>
              </div>
              <div style={{ display:"flex", gap:6 }}>
                <Btn variant="ghost" sm>View</Btn>
                <Btn variant="ghost" sm>⬇</Btn>
              </div>
            </div>
          ))}
          <div style={{ marginTop:14, textAlign:"center" }}><Btn variant="ghost">⬆ Upload Document</Btn></div>
        </Card>
      )}

      {tab==="site_photos" && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12 }}>
          {["Structural","Electrical","Safety","Progress","Inspection","Concrete","Framing"].map((tag,i) => {
            const cols = [T.blue,T.accent,T.amber,T.red,"#F5A623",T.purple,T.green];
            return (
              <Card key={i} style={{ padding:0, overflow:"hidden" }}>
                <div style={{ height:110, background:cols[i]+"22", display:"flex", alignItems:"center", justifyContent:"center", position:"relative" }}>
                  <span style={{ fontSize:32, opacity:.4 }}>📷</span>
                  <div style={{ position:"absolute", top:7, right:7 }}><Badge status={tag} small /></div>
                </div>
                <div style={{ padding:10 }}>
                  <p style={{ color:T.text, fontSize:11, fontWeight:600, margin:0 }}>Site Photo {i+1}</p>
                  <p style={{ color:T.muted, fontSize:10, margin:"2px 0 0" }}>Oct 2024 · Tom Walsh</p>
                </div>
              </Card>
            );
          })}
          <Card style={{ padding:0, border:"2px dashed "+T.border, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", minHeight:148, cursor:"pointer", gap:6 }}>
            <span style={{ fontSize:26, opacity:.3 }}>+</span>
            <span style={{ color:T.muted, fontSize:12 }}>Upload Photo</span>
          </Card>
        </div>
      )}

      {tab==="markups" && (
        <Card style={{ textAlign:"center", padding:60 }}>
          <span style={{ fontSize:48, display:"block", marginBottom:12 }}>✏️</span>
          <h3 style={{ color:T.text, fontWeight:700, marginBottom:8 }}>Markup History</h3>
          <p style={{ color:T.muted, fontSize:13 }}>Open a drawing and use the Markup tool to create annotations.</p>
        </Card>
      )}
    </div>
  );
}

// ─── PURCHASE ORDERS ─────────────────────────────────────────────────────────────
function PurchaseOrders() {
  const [showForm, setShowForm] = useState(false);
  const POS = [
    { ref:"PO-2024-001", supplier:"ABC Concrete Supplies", item:"Ready-mix concrete 32MPa", total:81000,  status:"Delivered", date:"15/10/2024" },
    { ref:"PO-2024-002", supplier:"Steel & Iron Co",       item:"N20 Reinforcing bar",      total:28800,  status:"Approved",  date:"20/10/2024" },
    { ref:"PO-2024-003", supplier:"Timber World",          item:"Formwork timber LVL",      total:36000,  status:"Sent",      date:"01/11/2024" },
  ];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Purchase Orders" sub="Create, send and track all supplier POs" action={<Btn onClick={() => setShowForm(!showForm)}>+ New PO</Btn>} />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12, marginBottom:18 }}>
        <Stat label="Sent"      value={POS.filter(p=>p.status==="Sent").length}      icon="📤" />
        <Stat label="Approved"  value={POS.filter(p=>p.status==="Approved").length}  icon="✅" color={T.green} />
        <Stat label="Delivered" value={POS.filter(p=>p.status==="Delivered").length} icon="📦" color={T.purple} />
        <Stat label="Total"     value={$K(POS.reduce((a,p)=>a+p.total,0))}          icon="💰" color="#F5A623" />
      </div>
      {showForm && (
        <Card style={{ marginBottom:14, border:"1px solid #00C9A740" }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:13 }}>New Purchase Order</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
            {["Project","Supplier","Item Description","Quantity","Unit","Unit Cost"].map(l => <Field key={l} label={l} placeholder={l} />)}
          </div>
          <div style={{ display:"flex", gap:8 }}><Btn onClick={() => setShowForm(false)}>Send PO</Btn><Btn variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn></div>
        </Card>
      )}
      <Card style={{ padding:0, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:T.card }}>
              {["PO Ref","Supplier","Item","Total","Status","Date",""].map(h => (
                <th key={h} style={{ textAlign:"left", padding:"10px 14px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", borderBottom:"1px solid "+T.border }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {POS.map(p => (
              <tr key={p.ref} style={{ borderBottom:"1px solid "+T.border }}
                onMouseEnter={e => e.currentTarget.style.background=T.card}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <td style={{ padding:"11px 14px", color:T.accent, fontSize:12, fontWeight:700 }}>{p.ref}</td>
                <td style={{ padding:"11px 14px", color:T.text, fontSize:12 }}>{p.supplier}</td>
                <td style={{ padding:"11px 14px", color:T.muted, fontSize:12 }}>{p.item}</td>
                <td style={{ padding:"11px 14px", color:"#F5A623", fontSize:13, fontWeight:700 }}>{$(p.total)}</td>
                <td style={{ padding:"11px 14px" }}><Badge status={p.status} small /></td>
                <td style={{ padding:"11px 14px", color:T.muted, fontSize:12 }}>{p.date}</td>
                <td style={{ padding:"11px 14px" }}>
                  <div style={{ display:"flex", gap:6 }}>
                    <Btn variant="ghost" sm>View</Btn>
                    {p.status==="Sent" && <Btn variant="success" sm>Approve</Btn>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── QS TAKEOFF ──────────────────────────────────────────────────────────────────
function QSTakeoff() {
  const [uploaded,  setUploaded]  = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [done,      setDone]      = useState(false);
  function runAI() { setAnalyzing(true); setTimeout(() => { setAnalyzing(false); setDone(true); }, 2500); }
  const RESULTS = [
    { el:"Concrete Slab",   det:"Level 3 floor", qty:"342", unit:"m²",   conf:98 },
    { el:"Internal Walls",  det:"Partitions",    qty:"186", unit:"lm",   conf:95 },
    { el:"External Walls",  det:"Perimeter",     qty:"124", unit:"lm",   conf:97 },
    { el:"Doors",           det:"Openings",      qty:"28",  unit:"each", conf:92 },
    { el:"Windows",         det:"Glazed",        qty:"34",  unit:"each", conf:89 },
    { el:"Columns",         det:"Structural",    qty:"12",  unit:"each", conf:98 },
  ];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="QS Takeoff — Constrapp Quant™" sub="AI-powered quantity extraction from drawings · patent-pending" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:20 }}>
        <Card>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:14 }}>Upload Drawing</h3>
          <div onClick={() => setUploaded(true)}
            style={{ border:"2px dashed "+(uploaded?T.accent:T.border), borderRadius:12, padding:44, textAlign:"center", cursor:"pointer", background:uploaded?T.accentDim:"transparent", transition:"all .2s" }}>
            <div style={{ fontSize:40, marginBottom:8 }}>{uploaded?"✅":"📐"}</div>
            <p style={{ color:uploaded?T.accent:T.muted, fontSize:13, margin:0, fontWeight:600 }}>
              {uploaded ? "Floor Plan Level 3.pdf uploaded" : "Click to upload PDF, DWG or image"}
            </p>
          </div>
          {uploaded && !done && (
            <div style={{ display:"flex", gap:8, marginTop:12 }}>
              <Btn onClick={runAI}>{analyzing ? "⚡ Analysing…" : "🤖 Run AI Takeoff"}</Btn>
              <Btn variant="ghost">Manual Entry</Btn>
            </div>
          )}
          {analyzing && (
            <div style={{ marginTop:10, background:T.bg, borderRadius:8, padding:12 }}>
              {["Detecting walls…","Counting openings…","Measuring areas…","Building schedule…"].map((s,i) => (
                <div key={i} style={{ display:"flex", gap:8, marginBottom:6 }}>
                  <div style={{ width:7, height:7, borderRadius:"50%", background:T.accent, marginTop:3 }} />
                  <span style={{ color:T.muted, fontSize:12 }}>{s}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card style={{ background:"linear-gradient(135deg,"+T.surface+",#0A1E30)" }}>
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:12 }}>
            <span style={{ fontSize:24 }}>🧠</span>
            <div>
              <h3 style={{ color:T.accent, fontWeight:800, margin:0, fontSize:14 }}>Constrapp Quant™ AI Engine</h3>
              <p style={{ color:T.muted, fontSize:11, margin:0 }}>Original technology · Patent-pending · Exclusive to Constrapp</p>
            </div>
          </div>
          {["Auto-detect structural elements from drawings","Calculate areas, volumes & linear metres","Link quantities directly to cost codes","Connect to Purchase Orders automatically","Export straight to BOQ & Tender Tool","Manual QS override always available"].map((f,i) => (
            <div key={i} style={{ display:"flex", gap:8, marginBottom:8 }}>
              <span style={{ color:T.accent, fontSize:11, flexShrink:0, marginTop:2 }}>✓</span>
              <span style={{ color:T.text, fontSize:12 }}>{f}</span>
            </div>
          ))}
        </Card>
      </div>
      {done && (
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div>
              <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>AI Results — Level 3 Floor Plan</h3>
              <p style={{ color:T.accent, fontSize:11, marginTop:3 }}>✓ Constrapp Quant™ complete · 94% confidence</p>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn variant="ghost" sm>Export CSV</Btn>
              <Btn sm>→ Send to BOQ</Btn>
            </div>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ borderBottom:"1px solid "+T.border }}>
                {["Element","Detected","Qty","Unit","Confidence",""].map(h => (
                  <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RESULTS.map((r,i) => (
                <tr key={i} style={{ borderBottom:"1px solid "+T.border }}
                  onMouseEnter={e => e.currentTarget.style.background=T.card}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  <td style={{ padding:"10px 12px", color:T.text, fontSize:12, fontWeight:600 }}>{r.el}</td>
                  <td style={{ padding:"10px 12px", color:T.muted, fontSize:12 }}>{r.det}</td>
                  <td style={{ padding:"10px 12px", color:T.accent, fontSize:15, fontWeight:900 }}>{r.qty}</td>
                  <td style={{ padding:"10px 12px", color:T.muted, fontSize:12 }}>{r.unit}</td>
                  <td style={{ padding:"10px 12px", minWidth:110 }}>
                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                      <div style={{ flex:1 }}><ProgBar val={r.conf} color={r.conf>93?T.green:r.conf>88?T.amber:T.red} h={4} /></div>
                      <span style={{ color:T.muted, fontSize:10 }}>{r.conf}%</span>
                    </div>
                  </td>
                  <td style={{ padding:"10px 12px" }}><Btn variant="ghost" sm>Edit</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ─── SUBCONTRACTORS ──────────────────────────────────────────────────────────────
function Subcontractors() {
  const [tab, setTab] = useState("subcontractors");
  const SUBBIES = [
    { co:"Precision Electrical",  trade:"Electrical",     contact:"Mike Johnson", score:92, onTime:"95%", vars:2 },
    { co:"ProPlumb QLD",          trade:"Plumbing",       contact:"Dave Smith",   score:78, onTime:"82%", vars:5 },
    { co:"SteelFab Solutions",    trade:"Structural Steel",contact:"Ray Collins", score:95, onTime:"98%", vars:1 },
    { co:"TopTile & Stone",       trade:"Tiling",         contact:"Anna Park",    score:65, onTime:"70%", vars:8 },
  ];
  const COSTS = [
    { code:"1000", desc:"Site Preparation",    c:344000, a:344000, f:344000, status:"Complete"    },
    { code:"2000", desc:"Concrete Works",      c:480000, a:280000, f:520000, status:"In Progress" },
    { code:"3000", desc:"Framing & Carpentry", c:736000, a:180000, f:760000, status:"In Progress" },
    { code:"4000", desc:"Electrical",          c:220000, a:0,      f:235000, status:"Pending"     },
    { code:"5000", desc:"Plumbing",            c:180000, a:0,      f:192000, status:"Pending"     },
  ];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Subcontractors" sub="Constrapp IQ™ — accountability engine" action={<Btn>+ Add Subcontractor</Btn>} />
      <div style={{ display:"flex", gap:4, marginBottom:18, borderBottom:"1px solid "+T.border }}>
        {["Subcontractors","Suppliers"].map(t => {
          const k = t.toLowerCase(); const a = tab===k;
          return <button key={t} onClick={() => setTab(k)} style={{ background:"transparent", border:"none", borderBottom:a?"2px solid "+T.accent:"2px solid transparent", color:a?T.accent:T.muted, fontWeight:a?700:400, fontSize:13, padding:"8px 16px", cursor:"pointer", fontFamily:"inherit", marginBottom:-1 }}>{t}</button>;
        })}
      </div>
      {tab==="subcontractors" && (
        <>
          <div style={{ background:"linear-gradient(135deg,"+T.surface+",#0A1E30)", border:"1px solid #00C9A733", borderRadius:12, padding:16, marginBottom:18, display:"flex", alignItems:"center", gap:14 }}>
            <span style={{ fontSize:26 }}>🧠</span>
            <div>
              <h3 style={{ color:T.accent, fontWeight:800, margin:0, fontSize:13 }}>Constrapp IQ™ — Subcontractor Accountability Engine</h3>
              <p style={{ color:T.muted, fontSize:12, margin:"3px 0 0" }}>Scores calculated from deadlines, rework, variations and site activity.</p>
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:18 }}>
            {SUBBIES.map((s,i) => {
              const col = s.score>=85?T.green:s.score>=70?T.amber:T.red;
              return (
                <Card key={i}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                    <div>
                      <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>{s.co}</h3>
                      <p style={{ color:T.muted, fontSize:12, margin:"3px 0 0" }}>{s.trade} · {s.contact}</p>
                    </div>
                    <div style={{ width:50, height:50, borderRadius:"50%", border:"3px solid "+col, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      <span style={{ color:T.text, fontSize:16, fontWeight:900 }}>{s.score}</span>
                    </div>
                  </div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                    {[["Score",s.score+"/100",col],["On-Time",s.onTime,T.accent],["Variations",s.vars,T.amber]].map(([l,v,c]) => (
                      <div key={l} style={{ background:T.bg, borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
                        <p style={{ color:c, fontSize:14, fontWeight:800, margin:0 }}>{v}</p>
                        <p style={{ color:T.muted, fontSize:10, margin:0 }}>{l}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
          <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, overflow:"hidden" }}>
            <div style={{ display:"flex", gap:0, borderBottom:"1px solid "+T.border, padding:"0 20px", background:T.card }}>
              {["Overview","Budget","Variations","POS Takeoff","Timeline"].map((t,i) => (
                <button key={t} style={{ background:"transparent", border:"none", borderBottom:i===1?"2px solid "+T.accent:"2px solid transparent", color:i===1?T.accent:T.muted, fontSize:12, fontWeight:i===1?700:400, padding:"10px 14px", cursor:"pointer", fontFamily:"inherit", marginBottom:-1 }}>{t}</button>
              ))}
            </div>
            <div style={{ padding:20 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Budget & Cost Codes</h3>
                <Btn sm>+ Add Cost Code</Btn>
              </div>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid "+T.border }}>
                    {["Cost Code","Description","Contracted","Actual","Forecast","Status",""].map(h => (
                      <th key={h} style={{ textAlign:"left", padding:"7px 12px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COSTS.map(r => (
                    <tr key={r.code} style={{ borderBottom:"1px solid "+T.border }}
                      onMouseEnter={e => e.currentTarget.style.background=T.card}
                      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                      <td style={{ padding:"11px 12px", color:T.accent, fontSize:13, fontWeight:700 }}>{r.code}</td>
                      <td style={{ padding:"11px 12px", color:T.text, fontSize:13 }}>{r.desc}</td>
                      <td style={{ padding:"11px 12px", color:T.textSoft, fontSize:13 }}>{$(r.c)}</td>
                      <td style={{ padding:"11px 12px", color:T.text, fontSize:13, fontWeight:600 }}>{$(r.a)}</td>
                      <td style={{ padding:"11px 12px", color:r.f>r.c*1.05?T.red:T.green, fontSize:13, fontWeight:600 }}>{$(r.f)}</td>
                      <td style={{ padding:"11px 12px" }}><Badge status={r.status} small /></td>
                      <td style={{ padding:"11px 12px" }}><Btn variant="ghost" sm>View ▾</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {tab==="suppliers" && (
        <Card style={{ textAlign:"center", padding:60 }}>
          <span style={{ fontSize:40, display:"block", marginBottom:12 }}>🏭</span>
          <h3 style={{ color:T.text, fontWeight:700, marginBottom:8 }}>Supplier Portal</h3>
          <p style={{ color:T.muted, fontSize:13, marginBottom:16 }}>Add and manage your approved supplier list.</p>
          <Btn>+ Add Supplier</Btn>
        </Card>
      )}
    </div>
  );
}

// ─── PULSE ───────────────────────────────────────────────────────────────────────
function Pulse({ company }) {
  const [tick, setTick] = useState(0);
  const [exp,  setExp]  = useState(null);
  const canvasRef       = useRef(null);
  const projects        = PROJECTS[company.id] || [];

  useEffect(() => {
    const iv = setInterval(() => setTick(t => t+1), 80);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if(!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const t = tick * 0.08;
    function drawLine(sw, sc, blur) {
      ctx.strokeStyle = sc; ctx.lineWidth = sw; ctx.shadowBlur = blur; ctx.shadowColor = "#FF6B9D";
      ctx.beginPath();
      for(let x=0; x<W; x++) {
        const prg = x/W;
        const wave = Math.sin(prg*Math.PI*6 - t*2)*12;
        const s1   = (x>W*.3 && x<W*.32) ? Math.sin((x-W*.3)/(W*.02)*Math.PI)*55 : 0;
        const s2   = (x>W*.65 && x<W*.67) ? Math.sin((x-W*.65)/(W*.02)*Math.PI)*40 : 0;
        const y    = H/2 - wave - s1 - s2;
        x===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
    drawLine(2.5, "#FF6B9D", 12);
    drawLine(6,   "#FF6B9D44", 28);
  }, [tick]);

  const metrics = [
    { lbl:"Budget Health",      score:82, col:T.green,  icon:"💰", detail:"2 of 3 projects within budget. Westfield showing 4% overrun risk.", trend:"+2%"  },
    { lbl:"Schedule Health",    score:68, col:T.amber,  icon:"⏱", detail:"Westfield 18 days behind forecast. IQ suggests accelerating.",     trend:"-5%"  },
    { lbl:"Team Performance",   score:91, col:T.green,  icon:"👷", detail:"Subcontractor on-time rate 91%. 4 of 5 subs above benchmark.",     trend:"+3%"  },
    { lbl:"Site Activity",      score:74, col:T.blue,   icon:"📷", detail:"18 photos uploaded this week. Site diary updated daily.",          trend:"+8%"  },
    { lbl:"Variation Velocity", score:55, col:T.amber,  icon:"⚡", detail:"3 variations pending approval. Combined value $217,000.",          trend:"-12%" },
    { lbl:"Client Sentiment",   score:88, col:T.accent, icon:"🤝", detail:"Last 3 client interactions positive. 0 escalated issues.",        trend:"+4%"  },
  ];
  const overall  = Math.round(metrics.reduce((a,m) => a+m.score, 0)/metrics.length);
  const pulseCol = overall>=80?T.green:overall>=60?T.amber:T.red;

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Constrapp PULSE™" sub="World's first living AI construction health engine — original to Constrapp · patent-pending" />
      <div style={{ background:"linear-gradient(135deg,"+T.surface+",#0A1E30)", border:"1px solid #00C9A733", borderRadius:14, padding:28, marginBottom:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:24, marginBottom:22 }}>
          <div style={{ position:"relative", flexShrink:0 }}>
            <svg width={110} height={110} viewBox="0 0 110 110">
              <circle cx="55" cy="55" r="48" stroke={T.border} strokeWidth="6" fill="none"/>
              <circle cx="55" cy="55" r="48" stroke={pulseCol} strokeWidth="6" fill="none"
                strokeDasharray={2*Math.PI*48*overall/100+" "+2*Math.PI*48}
                strokeLinecap="round" strokeDashoffset={2*Math.PI*48*.25}
                style={{ filter:"drop-shadow(0 0 8px "+pulseCol+")" }}/>
              <text x="55" y="50" textAnchor="middle" fill={pulseCol} fontSize="26" fontWeight="900" fontFamily="inherit">{overall}</text>
              <text x="55" y="68" textAnchor="middle" fill={T.muted} fontSize="10" fontFamily="inherit">PULSE SCORE</text>
            </svg>
            <div style={{ position:"absolute", bottom:4, right:4, width:16, height:16, borderRadius:"50%", background:pulseCol, animation:"pd 1.2s ease-in-out infinite" }}/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:8 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#FF6B9D", animation:"pd 1s ease-in-out infinite" }}/>
              <span style={{ color:"#FF6B9D", fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px" }}>Live Project Heartbeat</span>
            </div>
            <canvas ref={canvasRef} width={480} height={78} style={{ width:"100%", maxWidth:480, height:78, borderRadius:8 }}/>
          </div>
          <div style={{ textAlign:"right", flexShrink:0 }}>
            <p style={{ color:T.muted, fontSize:11, margin:0 }}>Portfolio Status</p>
            <p style={{ color:pulseCol, fontSize:13, fontWeight:700, margin:"4px 0" }}>{overall>=80?"✅ Strong":overall>=60?"⚠️ Needs Attention":"🚨 Critical"}</p>
            <p style={{ color:T.muted, fontSize:11, margin:0 }}>{projects.length} active projects</p>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
          {metrics.map((m,i) => (
            <div key={i} onClick={() => setExp(exp===i?null:i)}
              style={{ background:T.bg, borderRadius:10, padding:"12px 14px", cursor:"pointer", border:"1px solid "+(exp===i?m.col+"55":T.border), transition:"all .2s" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                <div>
                  <span style={{ fontSize:16 }}>{m.icon}</span>
                  <p style={{ color:T.textSoft, fontSize:11, fontWeight:600, margin:"3px 0 0" }}>{m.lbl}</p>
                </div>
                <div style={{ textAlign:"right" }}>
                  <p style={{ color:m.col, fontSize:20, fontWeight:900, margin:0 }}>{m.score}</p>
                  <p style={{ color:m.trend.startsWith("+")?T.green:T.red, fontSize:10, margin:0 }}>{m.trend}</p>
                </div>
              </div>
              <ProgBar val={m.score} color={m.col} h={4} />
              {exp===i && <p style={{ color:T.muted, fontSize:11, margin:"8px 0 0", lineHeight:1.5 }}>{m.detail}</p>}
            </div>
          ))}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <Card>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>🧠 Constrapp IQ™ Live Alerts</h3>
          {[
            { type:"warn",    msg:"Westfield — Schedule alert: 18 days behind. IQ suggests accelerating steel delivery."  },
            { type:"info",    msg:"Lakeside — VAR-003 ($185k): +18 days, cashflow −$32k in Month 8."                     },
            { type:"success", msg:"Greenview — On track. Budget 68%. Subbie avg score: 89."                               },
            { type:"danger",  msg:"3 unapproved variations totalling $217,000 — client approval needed."                  },
          ].map((a,i) => {
            const c = { warn:T.amber, info:T.blue, success:T.green, danger:T.red };
            const ic= { warn:"⚠️",   info:"💡",    success:"✅",      danger:"🚨"  };
            return (
              <div key={i} style={{ padding:"10px 12px", background:T.bg, borderRadius:9, marginBottom:8, borderLeft:"3px solid "+c[a.type] }}>
                <div style={{ display:"flex", gap:8 }}>
                  <span style={{ fontSize:14 }}>{ic[a.type]}</span>
                  <p style={{ color:T.text, fontSize:12, margin:0, lineHeight:1.5 }}>{a.msg}</p>
                </div>
              </div>
            );
          })}
        </Card>
        <Card>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>📊 Project Pulse Scores</h3>
          {projects.slice(0,4).map((p,i) => {
            const ps  = [78,52,88,72][i%4];
            const pc2 = ps>=75?T.green:ps>=55?T.amber:T.red;
            return (
              <div key={p.id} style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                  <div>
                    <p style={{ color:T.text, fontSize:12, fontWeight:600, margin:0 }}>{p.name}</p>
                    <p style={{ color:T.muted, fontSize:10, margin:0 }}>{p.location}</p>
                  </div>
                  <div><span style={{ color:pc2, fontSize:18, fontWeight:900 }}>{ps}</span><span style={{ color:T.muted, fontSize:10 }}>/100</span></div>
                </div>
                <ProgBar val={ps} color={pc2} />
              </div>
            );
          })}
          <div style={{ marginTop:12, padding:"10px 12px", background:T.accentDim, borderRadius:8, border:"1px solid #00C9A733" }}>
            <p style={{ color:T.accent, fontSize:11, fontWeight:700, margin:0 }}>🔒 Constrapp PULSE™ is original IP — patent-pending technology exclusive to this platform.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── TIMELINE ────────────────────────────────────────────────────────────────────
function Timeline({ company }) {
  const projects = PROJECTS[company.id] || [];
  const months   = ["Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar","Apr"];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Timeline — Constrapp IQ™" sub="AI-powered scheduling and delay prediction" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:20 }}>
        {[{i:"⚠️",t:"Delay Risk",m:"Westfield 18 days behind",c:T.amber},{i:"💡",t:"Variation Impact",m:"VAR-003 adds 18 days to Lakeside",c:T.blue},{i:"✅",t:"On Track",m:"Greenview within schedule",c:T.green}].map(a => (
          <div key={a.t} style={{ background:a.c+"18", border:"1px solid "+a.c+"33", borderRadius:10, padding:14 }}>
            <div style={{ display:"flex", gap:8 }}>
              <span style={{ fontSize:16 }}>{a.i}</span>
              <div>
                <p style={{ color:a.c, fontSize:12, fontWeight:700, margin:0 }}>{a.t}</p>
                <p style={{ color:T.muted, fontSize:11, margin:"3px 0 0" }}>{a.m}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Card>
        <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 16px", fontSize:14 }}>Gantt Schedule View</h3>
        {projects.map((p,pi) => {
          const starts = [1,3,0,2];
          const lens   = [5,7,4,5];
          const color  = p.status==="In Progress"?T.accent:p.status==="Backlogged"?T.amber:T.blue;
          return (
            <div key={p.id} style={{ display:"grid", gridTemplateColumns:"185px 1fr", marginBottom:14, alignItems:"center", gap:12 }}>
              <div>
                <p style={{ color:T.text, fontSize:12, fontWeight:600, margin:0 }}>{p.name.split(" ").slice(0,2).join(" ")}</p>
                <Badge status={p.status} small />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr", gap:2 }}>
                {months.map((m,mi) => {
                  const s = starts[pi%4], l = lens[pi%4];
                  const inBar = mi>=s && mi<s+l;
                  const first = mi===s, last = mi===s+l-1;
                  return (
                    <div key={m} style={{ height:24, background:inBar?color:T.bg, borderRadius:first?"6px 0 0 6px":last?"0 6px 6px 0":0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {inBar && first && <span style={{ fontSize:9, color:"#000", fontWeight:700 }}>{p.pct}%</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div style={{ display:"grid", gridTemplateColumns:"185px 1fr", marginTop:4, gap:12 }}>
          <div/>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr", gap:2 }}>
            {months.map(m => <div key={m} style={{ textAlign:"center", color:T.muted, fontSize:9 }}>{m}</div>)}
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── PHOTOS ──────────────────────────────────────────────────────────────────────
function Photos({ company }) {
  const projects = PROJECTS[company.id] || [];
  const [selId, setSelId] = useState(projects.length>0?projects[0].id:"");
  const TITLES = ["Level 3 Concrete Pour","Foundation Inspection","Formwork Setup L4","Site Safety Audit","Electrical Rough-in","Framing Level 2"];
  const COLS   = [T.blue,T.accent,T.amber,T.red,"#F5A623",T.purple];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Site Photos" sub="Upload and tag photos by project" action={<Btn>+ Upload Photos</Btn>} />
      <div style={{ display:"flex", gap:8, marginBottom:20 }}>
        {projects.map(p => (
          <button key={p.id} onClick={() => setSelId(p.id)}
            style={{ background:selId===p.id?T.accent:T.surface, color:selId===p.id?"#000":T.muted, border:"1px solid "+T.border, borderRadius:8, padding:"7px 14px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
            {p.name.split(" ").slice(0,2).join(" ")}
          </button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12 }}>
        {TITLES.map((title,i) => (
          <Card key={i} style={{ padding:0, overflow:"hidden" }}>
            <div style={{ height:120, background:COLS[i]+"22", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <span style={{ fontSize:32, opacity:.4 }}>📷</span>
            </div>
            <div style={{ padding:12 }}>
              <p style={{ color:T.text, fontSize:11, fontWeight:600, margin:0 }}>{title}</p>
              <p style={{ color:T.muted, fontSize:10, margin:"3px 0 0" }}>Oct 2024 · Tom Walsh</p>
            </div>
          </Card>
        ))}
        <Card style={{ padding:0, border:"2px dashed "+T.border, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", minHeight:150, cursor:"pointer", gap:6 }}>
          <span style={{ fontSize:26, opacity:.3 }}>+</span>
          <span style={{ color:T.muted, fontSize:12 }}>Upload Photo</span>
        </Card>
      </div>
    </div>
  );
}

// ─── REPORTS ─────────────────────────────────────────────────────────────────────
function Reports({ company }) {
  const projects = PROJECTS[company.id] || [];
  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <Head title="Reports" sub="Generate and export intelligence reports" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14, marginBottom:20 }}>
        {[["📊","Financial Report","Budget, actuals, variations & POs"],["🏗","Project Progress","Tasks, milestones & schedule"],["💓","PULSE™ Report","Portfolio health & AI alerts"],["📐","QS Quantity Report","Materials & measurements"],["⏱","Timeline & IQ Report","Schedule & predictions"],["💰","Cashflow Forecast","Income, expense & profit"]].map(([icon,t,d]) => (
          <Card key={t} onClick={() => {}}>
            <div style={{ fontSize:26, marginBottom:10 }}>{icon}</div>
            <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 6px", fontSize:13 }}>{t}</h3>
            <p style={{ color:T.muted, fontSize:11, margin:"0 0 14px" }}>{d}</p>
            <Btn sm>Generate PDF</Btn>
          </Card>
        ))}
      </div>
      <Card style={{ padding:0, overflow:"hidden" }}>
        <div style={{ padding:"14px 18px", borderBottom:"1px solid "+T.border, display:"flex", justifyContent:"space-between" }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Project Summary Report</h3>
          <div style={{ display:"flex", gap:8 }}><Btn sm>⬇ PDF</Btn><Btn variant="ghost" sm>⬇ CSV</Btn></div>
        </div>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr style={{ background:T.card }}>
              {["Project","Status","Budget","Spent","Profit","Margin","Progress"].map(h => (
                <th key={h} style={{ textAlign:"left", padding:"9px 14px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", borderBottom:"1px solid "+T.border }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map(p => (
              <tr key={p.id} style={{ borderBottom:"1px solid "+T.border }}
                onMouseEnter={e => e.currentTarget.style.background=T.card}
                onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                <td style={{ padding:"11px 14px" }}>
                  <p style={{ color:T.text, fontSize:12, fontWeight:600, margin:0 }}>{p.name}</p>
                  <p style={{ color:T.muted, fontSize:10, margin:0 }}>{p.location}</p>
                </td>
                <td style={{ padding:"11px 14px" }}><Badge status={p.status} small /></td>
                <td style={{ padding:"11px 14px", color:T.textSoft, fontSize:12 }}>{$K(p.budget)}</td>
                <td style={{ padding:"11px 14px", color:T.text, fontSize:12 }}>{$K(p.spent)}</td>
                <td style={{ padding:"11px 14px", color:T.green, fontSize:12, fontWeight:700 }}>{$K(p.revenue-p.budget)}</td>
                <td style={{ padding:"11px 14px", color:"#F5A623", fontSize:12, fontWeight:700 }}>{((p.revenue-p.budget)/p.revenue*100).toFixed(0)}%</td>
                <td style={{ padding:"11px 14px", minWidth:100 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ flex:1 }}><ProgBar val={p.pct}/></div>
                    <span style={{ color:T.muted, fontSize:10 }}>{p.pct}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── BILLING ─────────────────────────────────────────────────────────────────────
function Billing() {
  return (
    <div style={{ padding:24, maxWidth:900 }}>
      <Head title="Billing & Licensing" sub="Manage your Constrapp subscription" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14, marginBottom:20 }}>
        {MEMBERSHIP.map(p => (
          <Card key={p.id} style={{ border:p.popular?"2px solid #00C9A7":"1px solid "+T.border, position:"relative" }}>
            {p.popular && <div style={{ position:"absolute", top:-12, left:"50%", transform:"translateX(-50%)", background:"#00C9A7", color:"#000", fontSize:9, fontWeight:900, padding:"3px 12px", borderRadius:99, whiteSpace:"nowrap" }}>CURRENT</div>}
            <h3 style={{ color:p.color, fontWeight:900, margin:"0 0 4px", fontSize:13 }}>{p.name}</h3>
            <p style={{ color:T.text, fontSize:p.price?18:14, fontWeight:900, margin:"0 0 10px" }}>{p.price?"$"+p.price.toLocaleString()+"/yr":"Contact Us"}</p>
            {p.features.slice(0,3).map(f => (
              <div key={f} style={{ display:"flex", gap:5, marginBottom:5 }}>
                <span style={{ color:p.color, fontSize:10 }}>✓</span>
                <span style={{ color:T.muted, fontSize:10 }}>{f}</span>
              </div>
            ))}
            <div style={{ marginTop:12 }}>
              {p.popular ? <Btn sm style={{ width:"100%", justifyContent:"center" }}>Current Plan</Btn> : <Btn variant="ghost" sm style={{ width:"100%", justifyContent:"center" }}>Upgrade</Btn>}
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>Billing History</h3>
        {[{d:"01 Nov 2024",desc:"Professional Plan — Annual Subscription",amt:"$1,500.00"},{d:"01 Nov 2023",desc:"Professional Plan — Annual Subscription",amt:"$1,500.00"}].map((inv,i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 0", borderBottom:"1px solid "+T.border }}>
            <div>
              <p style={{ color:T.text, fontSize:13, margin:0 }}>{inv.desc}</p>
              <p style={{ color:T.muted, fontSize:11, margin:"2px 0 0" }}>{inv.d}</p>
            </div>
            <div style={{ display:"flex", gap:12, alignItems:"center" }}>
              <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>{inv.amt}</span>
              <Badge status="Approved" small />
              <Btn variant="ghost" sm>Receipt</Btn>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─── ROUTER + APP ─────────────────────────────────────────────────────────────────


// ─── BUDGETS ──────────────────────────────────────────────────────────────────
// Full project budget centre — cost codes, PO links, live burn, forecasting,
// printable report. Unique in the industry — no other app ties all this together.
function Budgets({ company, user }) {

  const BUDGET_DATA = {
    p1: {
      name: "Lakeside Apartments",
      contractValue: 4200000,
      approved: 3903006,
      contingency: 195150,
      variations: 265000,
      startDate: "01/09/2023",
      endDate: "30/09/2025",
      costCodes: [
        { code:"1000", desc:"Preliminaries & Site Setup",   budget:344000,  committed:344000, actual:344000,  invoiced:344000,  remaining:0,       pct:100, status:"Complete",    pos:["PO-001","PO-002"], category:"Prelim"    },
        { code:"2000", desc:"Concrete Works",               budget:680000,  committed:650000, actual:398000,  invoiced:310000,  remaining:282000,  pct:59,  status:"In Progress", pos:["PO-003","PO-004"], category:"Structure" },
        { code:"3000", desc:"Framing & Carpentry",          budget:420000,  committed:380000, actual:180000,  invoiced:160000,  remaining:240000,  pct:43,  status:"In Progress", pos:["PO-005"],          category:"Structure" },
        { code:"4000", desc:"Roofing & Waterproofing",      budget:210000,  committed:210000, actual:0,       invoiced:0,       remaining:210000,  pct:0,   status:"Pending",     pos:[],                  category:"Envelope"  },
        { code:"5000", desc:"External Cladding & Facades",  budget:185000,  committed:185000, actual:0,       invoiced:0,       remaining:185000,  pct:0,   status:"Pending",     pos:[],                  category:"Envelope"  },
        { code:"6000", desc:"Joinery, Doors & Windows",     budget:245000,  committed:220000, actual:95000,   invoiced:80000,   remaining:150000,  pct:39,  status:"In Progress", pos:["PO-006"],          category:"Fit-Out"   },
        { code:"7000", desc:"Electrical Services",          budget:220000,  committed:220000, actual:45000,   invoiced:30000,   remaining:175000,  pct:20,  status:"In Progress", pos:["PO-007"],          category:"Services"  },
        { code:"8000", desc:"Hydraulic & Plumbing",         budget:180000,  committed:175000, actual:30000,   invoiced:20000,   remaining:150000,  pct:17,  status:"In Progress", pos:[],                  category:"Services"  },
        { code:"9000", desc:"Painting & Finishes",          budget:120000,  committed:0,      actual:0,       invoiced:0,       remaining:120000,  pct:0,   status:"Not Started", pos:[],                  category:"Fit-Out"   },
        { code:"9500", desc:"Landscaping & External Works", budget:144000,  committed:0,      actual:0,       invoiced:0,       remaining:144000,  pct:0,   status:"Not Started", pos:[],                  category:"External"  },
        { code:"9900", desc:"Contingency Reserve",          budget:155006,  committed:0,      actual:0,       invoiced:0,       remaining:155006,  pct:0,   status:"Reserved",    pos:[],                  category:"Reserve"   },
      ],
    },
    p2: {
      name: "Westfield Office Tower",
      contractValue: 10500000,
      approved: 9700000,
      contingency: 485000,
      variations: 95000,
      startDate: "01/09/2023",
      endDate: "28/02/2026",
      costCodes: [
        { code:"1000", desc:"Preliminaries & Site Setup",   budget:820000,  committed:820000, actual:820000,  invoiced:820000,  remaining:0,       pct:100, status:"Complete",    pos:["PO-101"],          category:"Prelim"    },
        { code:"2000", desc:"Concrete & Structural Works",  budget:2100000, committed:2100000,actual:1200000, invoiced:900000,  remaining:900000,  pct:57,  status:"In Progress", pos:["PO-102","PO-103"], category:"Structure" },
        { code:"3000", desc:"Steel Frame & Facade",         budget:1800000, committed:1750000,actual:400000,  invoiced:300000,  remaining:1400000, pct:22,  status:"In Progress", pos:["PO-104"],          category:"Structure" },
        { code:"7000", desc:"Electrical & Communications",  budget:980000,  committed:500000, actual:0,       invoiced:0,       remaining:980000,  pct:0,   status:"Pending",     pos:[],                  category:"Services"  },
        { code:"8000", desc:"Hydraulic Services",           budget:760000,  committed:0,      actual:0,       invoiced:0,       remaining:760000,  pct:0,   status:"Not Started", pos:[],                  category:"Services"  },
        { code:"9900", desc:"Contingency Reserve",          budget:485000,  committed:0,      actual:0,       invoiced:0,       remaining:485000,  pct:0,   status:"Reserved",    pos:[],                  category:"Reserve"   },
      ],
    },
    p3: {
      name: "Greenview Retail Complex",
      contractValue: 1150000,
      approved: 1056000,
      contingency: 52800,
      variations: 32000,
      startDate: "01/03/2023",
      endDate: "31/12/2024",
      costCodes: [
        { code:"1000", desc:"Preliminaries",                budget:95000,   committed:95000,  actual:95000,   invoiced:95000,   remaining:0,       pct:100, status:"Complete",    pos:["PO-201"],          category:"Prelim"    },
        { code:"2000", desc:"Concrete & Slab Works",        budget:180000,  committed:180000, actual:180000,  invoiced:180000,  remaining:0,       pct:100, status:"Complete",    pos:["PO-202"],          category:"Structure" },
        { code:"3000", desc:"Framing",                      budget:145000,  committed:145000, actual:145000,  invoiced:145000,  remaining:0,       pct:100, status:"Complete",    pos:["PO-203"],          category:"Structure" },
        { code:"6000", desc:"Joinery & Shopfronts",         budget:210000,  committed:210000, actual:180000,  invoiced:160000,  remaining:30000,   pct:86,  status:"In Progress", pos:["PO-204"],          category:"Fit-Out"   },
        { code:"7000", desc:"Electrical",                   budget:148000,  committed:148000, actual:100000,  invoiced:90000,   remaining:48000,   pct:68,  status:"In Progress", pos:["PO-205"],          category:"Services"  },
        { code:"8000", desc:"Plumbing",                     budget:110000,  committed:108000, actual:80000,   invoiced:70000,   remaining:30000,   pct:73,  status:"In Progress", pos:[],                  category:"Services"  },
        { code:"9000", desc:"Painting & Finishes",          budget:115000,  committed:80000,  actual:40000,   invoiced:30000,   remaining:75000,   pct:35,  status:"In Progress", pos:[],                  category:"Fit-Out"   },
        { code:"9900", desc:"Contingency Reserve",          budget:53000,   committed:0,      actual:0,       invoiced:0,       remaining:53000,   pct:0,   status:"Reserved",    pos:[],                  category:"Reserve"   },
      ],
    },
  };

  const projects    = PROJECTS[company.id] || [];
  const [selId,     setSelId]     = useState(projects[0]?.id || "p1");
  const [filter,    setFilter]    = useState("All");
  const [search,    setSearch]    = useState("");
  const [selCode,   setSelCode]   = useState(null);
  const [printing,  setPrinting]  = useState(false);
  const [varOpen,   setVarOpen]   = useState(false);

  const proj    = BUDGET_DATA[selId] || BUDGET_DATA.p1;
  const allCats = ["All", ...new Set(proj.costCodes.map(c => c.category))];

  const filtered = proj.costCodes.filter(c => {
    const matchCat  = filter === "All" || c.category === filter;
    const matchSrch = c.desc.toLowerCase().includes(search.toLowerCase()) || c.code.includes(search);
    return matchCat && matchSrch;
  });

  // Totals
  const totBudget    = proj.costCodes.reduce((a,c) => a + c.budget,    0);
  const totCommitted = proj.costCodes.reduce((a,c) => a + c.committed, 0);
  const totActual    = proj.costCodes.reduce((a,c) => a + c.actual,    0);
  const totInvoiced  = proj.costCodes.reduce((a,c) => a + c.invoiced,  0);
  const totRemaining = proj.costCodes.reduce((a,c) => a + c.remaining, 0);
  const overBudget   = proj.costCodes.filter(c => c.committed > c.budget).length;
  const variance     = totBudget - totActual;
  const burnPct      = pc(totActual, totBudget);
  const profit       = proj.contractValue - proj.approved;
  const profPct      = ((profit / proj.contractValue) * 100).toFixed(1);

  // Category breakdown for donut
  const catTotals = allCats.filter(c => c !== "All").map(cat => ({
    name: cat,
    budget: proj.costCodes.filter(c => c.category===cat).reduce((a,c)=>a+c.budget,0),
    actual: proj.costCodes.filter(c => c.category===cat).reduce((a,c)=>a+c.actual,0),
  }));
  const catColors = { Prelim:"#00C9A7", Structure:"#3B82F6", Envelope:"#F59E0B", "Fit-Out":"#8B5CF6", Services:"#EF4444", External:"#F5A623", Reserve:"#546E84" };

  const statusCol = { "Complete":"#00C9A7", "In Progress":"#3B82F6", "Pending":"#F59E0B", "Not Started":"#546E84", "Reserved":"#8B5CF6" };

  const selCostCode = proj.costCodes.find(c => c.code === selCode);

  function simulatePrint() {
    setPrinting(true);
    setTimeout(() => setPrinting(false), 1800);
  }

  return (
    <div style={{ padding:24, maxWidth:1400 }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <h2 style={{ color:T.text, fontSize:20, fontWeight:800, margin:0 }}>Project Budgets</h2>
          <p style={{ color:T.muted, fontSize:13, margin:"4px 0 0" }}>Live cost tracking · Purchase order integration · Printable reports</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="ghost" onClick={() => setVarOpen(!varOpen)}>+ Add Variation</Btn>
          <Btn variant="ghost" onClick={simulatePrint}
            style={{ background:printing?"#00C9A718":"transparent", color:printing?T.accent:T.textSoft }}>
            {printing ? "⏳ Generating PDF…" : "🖨 Print Budget Report"}
          </Btn>
          <Btn>+ Add Cost Code</Btn>
        </div>
      </div>

      {printing && (
        <div style={{ background:"#00C9A718", border:"1px solid #00C9A744", borderRadius:10, padding:"11px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:T.accent, animation:"pd .6s ease-in-out infinite" }}/>
          <p style={{ color:T.accent, fontSize:13, fontWeight:600, margin:0 }}>
            Generating Budget Report PDF — {proj.name} · All cost codes · PO summary · Variance analysis…
          </p>
        </div>
      )}

      {/* Project selector pills */}
      <div style={{ display:"flex", gap:8, marginBottom:20, flexWrap:"wrap" }}>
        {projects.map(p => {
          const bd = BUDGET_DATA[p.id];
          const isOver = bd ? bd.costCodes.some(c => c.committed > c.budget) : false;
          return (
            <button key={p.id} onClick={() => { setSelId(p.id); setSelCode(null); }}
              style={{ background:selId===p.id ? T.accent : T.surface, color:selId===p.id ? "#000" : T.muted, border:"1px solid "+(selId===p.id ? T.accent : T.border), borderRadius:9, padding:"8px 16px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:7, transition:"all .15s" }}>
              {p.name.split(" ").slice(0,2).join(" ")}
              {isOver && <span style={{ width:7, height:7, borderRadius:"50%", background:selId===p.id?"#000":T.red, flexShrink:0 }}/>}
            </button>
          );
        })}
      </div>

      {/* Variation add form */}
      {varOpen && (
        <div style={{ background:T.surface, border:"1px solid #F59E0B44", borderRadius:12, padding:20, marginBottom:18 }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>Add Variation to {proj.name}</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12, marginBottom:12 }}>
            <Field label="Variation Ref"  placeholder="VAR-004" />
            <Field label="Description"    placeholder="Additional works description" />
            <Field label="Cost Code"      placeholder="e.g. 2000" />
            <Field label="Variation Amount ($)" placeholder="e.g. 48000" />
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <Btn onClick={() => setVarOpen(false)}>Add to Budget</Btn>
            <Btn variant="ghost" onClick={() => setVarOpen(false)}>Cancel</Btn>
          </div>
        </div>
      )}

      {/* KPI stat cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:12, marginBottom:20 }}>
        {[
          { label:"Contract Value", value:$K(proj.contractValue), col:"#3B82F6",  icon:"📄" },
          { label:"Approved Budget",value:$K(totBudget),          col:T.text,     icon:"💰" },
          { label:"Committed",      value:$K(totCommitted),       col:T.amber,    icon:"📋" },
          { label:"Actual Cost",    value:$K(totActual),          col:T.red,      icon:"💸" },
          { label:"Remaining",      value:$K(totRemaining),       col:T.green,    icon:"💎" },
          { label:"Gross Profit",   value:$K(profit)+" ("+profPct+"%)", col:"#F5A623", icon:"📈" },
        ].map(s => (
          <div key={s.label} style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:18, marginBottom:6, opacity:.8 }}>{s.icon}</div>
            <p style={{ color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", margin:"0 0 3px" }}>{s.label}</p>
            <p style={{ color:s.col, fontSize:16, fontWeight:900, margin:0, letterSpacing:"-0.3px" }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Budget burn bar */}
      <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:18, marginBottom:18 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ color:T.text, fontSize:14, fontWeight:700 }}>Overall Budget Burn</span>
            <span style={{ color:burnPct > 85 ? T.red : burnPct > 65 ? T.amber : T.green, fontSize:13, fontWeight:800 }}>{burnPct}%</span>
          </div>
          <div style={{ display:"flex", gap:18 }}>
            {[["Invoiced",totInvoiced,"#8B5CF6"],["Actual",totActual,T.red],["Committed",totCommitted,T.amber],["Budget",totBudget,T.green]].map(([l,v,c]) => (
              <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <div style={{ width:10, height:10, borderRadius:2, background:c }}/>
                <span style={{ color:T.muted, fontSize:11 }}>{l}: <strong style={{ color:T.textSoft }}>{$K(v)}</strong></span>
              </div>
            ))}
          </div>
        </div>
        {/* Stacked burn bar */}
        <div style={{ height:16, background:T.border, borderRadius:99, overflow:"hidden", display:"flex" }}>
          <div style={{ height:"100%", width:pc(totInvoiced,totBudget)+"%", background:"#8B5CF6", borderRadius:pc(totInvoiced,totBudget)>=99?"99px 0 0 99px":"0" }}/>
          <div style={{ height:"100%", width:(pc(totActual,totBudget)-pc(totInvoiced,totBudget))+"%", background:T.red }}/>
          <div style={{ height:"100%", width:(pc(totCommitted,totBudget)-pc(totActual,totBudget))+"%", background:T.amber }}/>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
          <span style={{ color:T.muted, fontSize:11 }}>$0</span>
          <span style={{ color:T.muted, fontSize:11 }}>Variance: <strong style={{ color:variance>=0?T.green:T.red }}>{variance>=0?"+":""}{$K(variance)}</strong></span>
          <span style={{ color:T.muted, fontSize:11 }}>{$(totBudget)}</span>
        </div>
        {overBudget > 0 && (
          <div style={{ marginTop:10, background:T.red+"12", border:"1px solid "+T.red+"33", borderRadius:8, padding:"8px 12px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:14 }}>⚠️</span>
            <span style={{ color:T.red, fontSize:12, fontWeight:600 }}>{overBudget} cost code{overBudget>1?"s":""} committed over budget — review required</span>
          </div>
        )}
      </div>

      {/* Main grid: table + detail panel */}
      <div style={{ display:"grid", gridTemplateColumns: selCode ? "1fr 360px" : "1fr", gap:14 }}>

        {/* Cost codes table */}
        <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, overflow:"hidden" }}>

          {/* Table toolbar */}
          <div style={{ padding:"14px 16px", borderBottom:"1px solid "+T.border, display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
            <input placeholder="Search cost codes…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ background:T.input, border:"1px solid "+T.border, borderRadius:8, padding:"6px 11px", color:T.text, fontSize:12, fontFamily:"inherit", outline:"none", width:200 }}
              onFocus={e => e.target.style.borderColor=T.accent} onBlur={e => e.target.style.borderColor=T.border} />
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {allCats.map(cat => (
                <button key={cat} onClick={() => setFilter(cat)}
                  style={{ background:filter===cat?(catColors[cat]||T.accent)+"22":"transparent", color:filter===cat?(catColors[cat]||T.accent):T.muted, border:"1px solid "+(filter===cat?(catColors[cat]||T.accent)+"55":T.border), borderRadius:7, padding:"4px 11px", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
                  {cat}
                </button>
              ))}
            </div>
            <span style={{ color:T.muted, fontSize:11, marginLeft:"auto" }}>{filtered.length} cost codes</span>
          </div>

          {/* Table */}
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", minWidth:820 }}>
              <thead>
                <tr style={{ background:T.card }}>
                  {["Code","Description","Category","Budget","Committed","Actual Cost","Invoiced","Remaining","Burn","Status",""].map(h => (
                    <th key={h} style={{ textAlign:"left", padding:"9px 12px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", borderBottom:"1px solid "+T.border, whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => {
                  const isOver   = row.committed > row.budget;
                  const burnVal  = pc(row.actual, row.budget);
                  const burnColor= burnVal > 90 ? T.red : burnVal > 70 ? T.amber : T.green;
                  const isSelected = selCode === row.code;
                  return (
                    <tr key={row.code}
                      onClick={() => setSelCode(isSelected ? null : row.code)}
                      style={{ borderBottom:"1px solid "+T.border, cursor:"pointer", background:isSelected?T.accentDim:"transparent", transition:"background .12s" }}
                      onMouseEnter={e => { if(!isSelected) e.currentTarget.style.background=T.card; }}
                      onMouseLeave={e => { if(!isSelected) e.currentTarget.style.background="transparent"; }}>
                      <td style={{ padding:"11px 12px", color:T.accent, fontSize:13, fontWeight:800 }}>{row.code}</td>
                      <td style={{ padding:"11px 12px" }}>
                        <p style={{ color:T.text, fontSize:12, fontWeight:600, margin:0 }}>{row.desc}</p>
                        {row.pos.length > 0 && <p style={{ color:T.muted, fontSize:10, margin:"2px 0 0" }}>{row.pos.length} PO{row.pos.length>1?"s":""} linked</p>}
                      </td>
                      <td style={{ padding:"11px 12px" }}>
                        <span style={{ background:(catColors[row.category]||T.muted)+"22", color:catColors[row.category]||T.muted, border:"1px solid "+(catColors[row.category]||T.muted)+"44", borderRadius:6, padding:"2px 8px", fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
                          {row.category}
                        </span>
                      </td>
                      <td style={{ padding:"11px 12px", color:T.textSoft, fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>{$(row.budget)}</td>
                      <td style={{ padding:"11px 12px", whiteSpace:"nowrap" }}>
                        <span style={{ color:isOver?T.red:T.text, fontSize:12, fontWeight:600 }}>{$(row.committed)}</span>
                        {isOver && <span style={{ color:T.red, fontSize:10, marginLeft:4 }}>▲ OVER</span>}
                      </td>
                      <td style={{ padding:"11px 12px", color:T.text, fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>{$(row.actual)}</td>
                      <td style={{ padding:"11px 12px", color:"#8B5CF6", fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>{$(row.invoiced)}</td>
                      <td style={{ padding:"11px 12px", whiteSpace:"nowrap" }}>
                        <span style={{ color:row.remaining===0?T.muted:T.green, fontSize:12, fontWeight:700 }}>
                          {row.remaining===0 ? "—" : $(row.remaining)}
                        </span>
                      </td>
                      <td style={{ padding:"11px 12px", minWidth:100 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                          <div style={{ flex:1, height:5, background:T.border, borderRadius:99, overflow:"hidden" }}>
                            <div style={{ height:"100%", width:Math.min(burnVal,100)+"%", background:burnColor, borderRadius:99 }}/>
                          </div>
                          <span style={{ color:burnColor, fontSize:10, fontWeight:700, minWidth:28 }}>{burnVal}%</span>
                        </div>
                      </td>
                      <td style={{ padding:"11px 12px" }}>
                        <span style={{ background:(statusCol[row.status]||T.muted)+"22", color:statusCol[row.status]||T.muted, border:"1px solid "+(statusCol[row.status]||T.muted)+"44", borderRadius:6, padding:"2px 8px", fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
                          {row.status}
                        </span>
                      </td>
                      <td style={{ padding:"11px 12px" }}>
                        <span style={{ color:T.accent, fontSize:16 }}>{isSelected ? "▸" : "›"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr style={{ background:T.card, borderTop:"2px solid "+T.border }}>
                  <td colSpan={3} style={{ padding:"11px 12px", color:T.text, fontSize:12, fontWeight:800 }}>TOTALS</td>
                  <td style={{ padding:"11px 12px", color:T.textSoft, fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>{$(filtered.reduce((a,c)=>a+c.budget,0))}</td>
                  <td style={{ padding:"11px 12px", color:T.amber,    fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>{$(filtered.reduce((a,c)=>a+c.committed,0))}</td>
                  <td style={{ padding:"11px 12px", color:T.red,      fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>{$(filtered.reduce((a,c)=>a+c.actual,0))}</td>
                  <td style={{ padding:"11px 12px", color:"#8B5CF6",  fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>{$(filtered.reduce((a,c)=>a+c.invoiced,0))}</td>
                  <td style={{ padding:"11px 12px", color:T.green,    fontSize:12, fontWeight:800, whiteSpace:"nowrap" }}>{$(filtered.reduce((a,c)=>a+c.remaining,0))}</td>
                  <td colSpan={3}/>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Detail panel — slides in when cost code selected */}
        {selCode && selCostCode && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

            {/* Cost code detail */}
            <div style={{ background:T.surface, border:"1px solid "+T.accent+"55", borderRadius:12, padding:18 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:14 }}>
                <div>
                  <span style={{ color:T.accent, fontSize:22, fontWeight:900 }}>{selCostCode.code}</span>
                  <p style={{ color:T.text, fontSize:13, fontWeight:700, margin:"3px 0 0" }}>{selCostCode.desc}</p>
                  <span style={{ background:(catColors[selCostCode.category]||T.muted)+"22", color:catColors[selCostCode.category]||T.muted, border:"1px solid "+(catColors[selCostCode.category]||T.muted)+"44", borderRadius:6, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{selCostCode.category}</span>
                </div>
                <button onClick={() => setSelCode(null)} style={{ background:"transparent", border:"none", color:T.muted, cursor:"pointer", fontSize:18, fontFamily:"inherit" }}>✕</button>
              </div>

              {[
                { label:"Budget",    value:$(selCostCode.budget),    color:T.textSoft, pct:100                                },
                { label:"Committed", value:$(selCostCode.committed), color:selCostCode.committed>selCostCode.budget?T.red:T.amber, pct:pc(selCostCode.committed,selCostCode.budget) },
                { label:"Actual",    value:$(selCostCode.actual),    color:T.red,      pct:pc(selCostCode.actual,selCostCode.budget)    },
                { label:"Invoiced",  value:$(selCostCode.invoiced),  color:"#8B5CF6",  pct:pc(selCostCode.invoiced,selCostCode.budget)  },
                { label:"Remaining", value:$(selCostCode.remaining), color:T.green,    pct:pc(selCostCode.remaining,selCostCode.budget) },
              ].map(r => (
                <div key={r.label} style={{ marginBottom:10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                    <span style={{ color:T.muted, fontSize:12 }}>{r.label}</span>
                    <span style={{ color:r.color, fontSize:13, fontWeight:700 }}>{r.value}</span>
                  </div>
                  <ProgBar val={r.pct} color={r.color} h={5} />
                </div>
              ))}

              <div style={{ marginTop:12, padding:"9px 12px", background:selCostCode.remaining>0?"#00C9A710":T.red+"10", borderRadius:8 }}>
                <span style={{ color:selCostCode.remaining>0?T.green:T.red, fontSize:12, fontWeight:700 }}>
                  {selCostCode.remaining>0 ? "✅ "+$(selCostCode.remaining)+" remaining in budget" : "⚠️ Budget fully consumed"}
                </span>
              </div>
            </div>

            {/* Linked POs */}
            <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:16 }}>
              <h4 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Linked Purchase Orders</h4>
              {selCostCode.pos.length > 0 ? (
                selCostCode.pos.map(po => (
                  <div key={po} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid "+T.border }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontSize:14 }}>📋</span>
                      <span style={{ color:T.accent, fontSize:12, fontWeight:700 }}>{po}</span>
                    </div>
                    <Btn variant="ghost" sm>View PO</Btn>
                  </div>
                ))
              ) : (
                <p style={{ color:T.muted, fontSize:12, margin:0 }}>No POs linked yet</p>
              )}
              <div style={{ marginTop:10 }}><Btn sm>+ Link PO</Btn></div>
            </div>

            {/* Forecast to complete */}
            <div style={{ background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:16 }}>
              <h4 style={{ color:T.text, fontWeight:700, margin:"0 0 12px", fontSize:13 }}>Forecast to Complete</h4>
              {[
                { label:"Budget at Completion",  value:$(selCostCode.budget),   color:T.textSoft  },
                { label:"Actual to Date",         value:$(selCostCode.actual),   color:T.red       },
                { label:"Forecast Remaining",     value:$(selCostCode.remaining),color:T.amber     },
                { label:"Estimated Final Cost",   value:$(selCostCode.committed),color:selCostCode.committed > selCostCode.budget ? T.red : T.green },
                { label:"Variance",               value:(selCostCode.budget - selCostCode.committed >= 0 ? "+" : "")+$(selCostCode.budget - selCostCode.committed), color:selCostCode.budget - selCostCode.committed >= 0 ? T.green : T.red },
              ].map(r => (
                <div key={r.label} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid "+T.border }}>
                  <span style={{ color:T.muted, fontSize:12 }}>{r.label}</span>
                  <span style={{ color:r.color, fontSize:13, fontWeight:700 }}>{r.value}</span>
                </div>
              ))}
            </div>

            <Btn style={{ width:"100%", justifyContent:"center" }} variant="ghost" onClick={simulatePrint}>
              🖨 Print Cost Code Report
            </Btn>
          </div>
        )}
      </div>

      {/* Category breakdown mini-charts */}
      <div style={{ marginTop:16, background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20 }}>
        <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 16px", fontSize:14 }}>Budget by Category — {proj.name}</h3>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12 }}>
          {catTotals.map(cat => {
            const b  = pc(cat.actual, cat.budget);
            const col= catColors[cat.name] || T.muted;
            return (
              <div key={cat.name} style={{ background:T.bg, borderRadius:10, padding:"12px 14px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                  <div>
                    <p style={{ color:col, fontSize:11, fontWeight:800, textTransform:"uppercase", letterSpacing:".4px", margin:0 }}>{cat.name}</p>
                    <p style={{ color:T.text, fontSize:15, fontWeight:900, margin:"3px 0 0" }}>{$K(cat.budget)}</p>
                  </div>
                  <span style={{ color:T.muted, fontSize:11, fontWeight:700 }}>{b}%</span>
                </div>
                <ProgBar val={b} color={col} h={6} />
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:5 }}>
                  <span style={{ color:T.muted, fontSize:10 }}>Spent: {$K(cat.actual)}</span>
                  <span style={{ color:T.muted, fontSize:10 }}>Left: {$K(cat.budget-cat.actual)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Print report preview panel */}
      <div style={{ marginTop:14, background:T.surface, border:"1px solid "+T.border, borderRadius:12, padding:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Budget Report Summary — {proj.name}</h3>
          <div style={{ display:"flex", gap:8 }}>
            <Btn variant="ghost" sm onClick={simulatePrint}>🖨 Print Full Report</Btn>
            <Btn variant="ghost" sm>⬇ Export CSV</Btn>
            <Btn variant="ghost" sm>⬇ Export Excel</Btn>
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:12, marginBottom:14 }}>
          {[
            { label:"Contract Value",   value:$K(proj.contractValue), sub:"Excl. GST",             col:"#3B82F6" },
            { label:"Approved Budget",  value:$K(totBudget),          sub:"Across "+proj.costCodes.length+" cost codes", col:T.text   },
            { label:"Total Actual",     value:$K(totActual),          sub:burnPct+"% of budget",   col:T.red    },
            { label:"Project Profit",   value:$K(profit),             sub:profPct+"% gross margin", col:"#F5A623"},
          ].map(s => (
            <div key={s.label} style={{ background:T.bg, borderRadius:10, padding:"12px 14px", borderLeft:"3px solid "+s.col }}>
              <p style={{ color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", margin:"0 0 4px" }}>{s.label}</p>
              <p style={{ color:s.col, fontSize:18, fontWeight:900, margin:0 }}>{s.value}</p>
              <p style={{ color:T.muted, fontSize:10, margin:"3px 0 0" }}>{s.sub}</p>
            </div>
          ))}
        </div>
        <div style={{ background:T.bg, borderRadius:10, padding:"12px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", gap:20 }}>
            <span style={{ color:T.muted, fontSize:12 }}>Variations: <strong style={{ color:T.amber }}>{$K(proj.variations)}</strong></span>
            <span style={{ color:T.muted, fontSize:12 }}>Contingency: <strong style={{ color:T.blue }}>{$K(proj.contingency)}</strong></span>
            <span style={{ color:T.muted, fontSize:12 }}>Over-budget codes: <strong style={{ color:overBudget>0?T.red:T.green }}>{overBudget}</strong></span>
            <span style={{ color:T.muted, fontSize:12 }}>Start: <strong style={{ color:T.textSoft }}>{proj.startDate}</strong></span>
            <span style={{ color:T.muted, fontSize:12 }}>End: <strong style={{ color:T.textSoft }}>{proj.endDate}</strong></span>
          </div>
          <span style={{ color:T.muted, fontSize:11 }}>Generated: {new Date().toLocaleDateString("en-AU")} · Constrapp v5</span>
        </div>
      </div>

    </div>
  );
}


// World-first construction security intelligence platform — original to Constrapp
// Combines: role-based audit trails, document integrity hashing, access anomaly
// detection, contract version locking, tamper-evident change logs, and a live
// security score. No other construction app has anything like this.
function Shield({ user, company }) {
  const [tab,      setTab]      = useState("overview");
  const [scanning, setScanning] = useState(false);
  const [scanned,  setScanned]  = useState(false);
  const [tick,     setTick]     = useState(0);

  useEffect(() => {
    const iv = setInterval(() => setTick(t => t+1), 1200);
    return () => clearInterval(iv);
  }, []);

  const SHIELD_BLUE = "#00D4FF";
  const SB          = SHIELD_BLUE;

  const SCORE = 94;

  const ACCESS_LOG = [
    { time:"Today 09:42", user:"Tom Walsh",    role:"Project Manager", action:"Viewed",   doc:"Head Contract v3 — Lakeside.pdf",        ip:"101.xx.xx.14", status:"Normal"    },
    { time:"Today 08:15", user:"Linda Chen",   role:"QS / Office",     action:"Exported", doc:"BOQ Tender — Westfield Office Tower.xlsx",ip:"101.xx.xx.18", status:"Normal"    },
    { time:"Yesterday",   user:"mark@subbies", role:"Subcontractor",   action:"Viewed",   doc:"Subcontract — Precision Electrical.pdf",  ip:"203.xx.xx.91", status:"Normal"    },
    { time:"Yesterday",   user:"Unknown",      role:"—",               action:"Failed login attempt × 3",doc:"—",                      ip:"185.xx.xx.22", status:"Alert"     },
    { time:"2 days ago",  user:"Sarah Mitchell",role:"Company Admin",  action:"Deleted",  doc:"Site Safety Plan Rev A.pdf",             ip:"101.xx.xx.18", status:"Logged"    },
    { time:"2 days ago",  user:"JP Richards",  role:"Super Admin",     action:"Locked",   doc:"Head Contract v3 — Lakeside.pdf",        ip:"101.xx.xx.10", status:"Protected" },
  ];

  const DOCUMENTS = [
    { name:"Head Contract — Lakeside Apartments",  hash:"a3f9c2...7e41",  locked:true,  ver:"v3", verified:true,  signed:"JP Richards · 01/09/2023",   tamper:false },
    { name:"Subcontract — Precision Electrical",   hash:"b7d1a4...2f88",  locked:true,  ver:"v2", verified:true,  signed:"Mike Johnson · 10/10/2023",  tamper:false },
    { name:"Site Safety Management Plan",          hash:"c2e8f1...9a33",  locked:false, ver:"v4", verified:true,  signed:"Sarah Mitchell · 15/11/2024", tamper:false },
    { name:"BOQ — Westfield Office Tower",         hash:"d5b3c7...1e62",  locked:false, ver:"v1", verified:false, signed:"Unsigned",                    tamper:false },
    { name:"Subcontract — ProPlumb QLD",           hash:"MISMATCH",       locked:false, ver:"v1", verified:false, signed:"Unsigned",                    tamper:true  },
  ];

  const PERMISSIONS = [
    { role:"Super Admin",     canView:true,  canEdit:true,  canDelete:true,  canExport:true,  canSign:true,  canLock:true  },
    { role:"Company Admin",   canView:true,  canEdit:true,  canDelete:true,  canExport:true,  canSign:true,  canLock:true  },
    { role:"Project Manager", canView:true,  canEdit:true,  canDelete:false, canExport:true,  canSign:false, canLock:false },
    { role:"QS / Office",     canView:true,  canEdit:true,  canDelete:false, canExport:true,  canSign:false, canLock:false },
    { role:"Subcontractor",   canView:true,  canEdit:false, canDelete:false, canExport:false, canSign:true,  canLock:false },
    { role:"Client",          canView:true,  canEdit:false, canDelete:false, canExport:false, canSign:true,  canLock:false },
  ];

  const THREATS = [
    { level:"High",   icon:"🚨", title:"Failed Login Attempts",     detail:"3 failed logins from IP 185.xx.xx.22 — unknown device. Account temporarily locked.", time:"Yesterday 11:34 PM" },
    { level:"Medium", icon:"⚠️", title:"Document Hash Mismatch",    detail:"ProPlumb Subcontract shows tamper signature. File may have been modified externally.",  time:"3 days ago"        },
    { level:"Low",    icon:"💡", title:"Unverified Export",          detail:"BOQ — Westfield exported without digital signature. Recommend signing before sending.",  time:"4 days ago"        },
    { level:"Info",   icon:"ℹ️", title:"New Device Login",           detail:"JP Richards logged in from a new browser. Location: Brisbane AU. Confirmed normal.",     time:"5 days ago"        },
  ];

  const threatCol = { High:"#EF4444", Medium:T.amber, Low:T.blue, Info:T.muted };

  const SECURITY_METRICS = [
    { label:"Document Integrity",   score:88, col:"#00D4FF", detail:"4 of 5 key documents hash-verified. 1 tamper alert." },
    { label:"Access Control",       score:96, col:T.green,   detail:"All role permissions correctly enforced. No privilege escalation detected." },
    { label:"Audit Trail Coverage", score:100,col:T.green,   detail:"100% of document actions logged with IP, timestamp and user identity." },
    { label:"Login Security",       score:82, col:T.amber,   detail:"MFA not yet enabled. 1 brute-force attempt blocked in last 7 days." },
    { label:"Contract Locking",     score:95, col:"#00D4FF", detail:"2 of 5 contracts cryptographically locked. Remaining 3 recommended." },
    { label:"Data Encryption",      score:100,col:T.green,   detail:"All documents AES-256 encrypted at rest and in transit." },
  ];

  function runScan() {
    setScanning(true);
    setTimeout(() => { setScanning(false); setScanned(true); }, 3000);
  }

  const tick3 = tick % 3;

  return (
    <div style={{ padding:24, maxWidth:1280 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:22 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:4 }}>
            <h2 style={{ color:T.text, fontSize:20, fontWeight:800, margin:0 }}>Constrapp SHIELD™</h2>
            <span style={{ background:SB+"22", color:SB, border:"1px solid "+SB+"44", borderRadius:99, padding:"2px 10px", fontSize:11, fontWeight:700 }}>LIVE</span>
          </div>
          <p style={{ color:T.muted, fontSize:13, margin:0 }}>Construction-grade security intelligence — original to Constrapp · patent-pending</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn onClick={runScan} style={{ background:"linear-gradient(90deg,#00D4FF,#0099CC)", color:"#000" }}>
            {scanning ? "🔍 Scanning…" : "🛡 Run Security Scan"}
          </Btn>
          <Btn variant="ghost">⬇ Export Security Report</Btn>
        </div>
      </div>

      {/* Security Score Hero */}
      <div style={{ background:"linear-gradient(135deg,#050E1A 0%,#08182A 60%,#050E1A 100%)", border:"1px solid "+SB+"33", borderRadius:14, padding:28, marginBottom:20, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-80, right:-80, width:300, height:300, borderRadius:"50%", background:SB+"08", pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:-60, left:-60, width:200, height:200, borderRadius:"50%", background:SB+"05", pointerEvents:"none" }} />

        <div style={{ display:"grid", gridTemplateColumns:"180px 1fr", gap:32, alignItems:"center" }}>
          {/* Circular score */}
          <div style={{ position:"relative", width:160, height:160, margin:"0 auto" }}>
            <svg width={160} height={160} viewBox="0 0 160 160">
              <circle cx="80" cy="80" r="68" stroke={T.border} strokeWidth="8" fill="none"/>
              <circle cx="80" cy="80" r="68" stroke={SB} strokeWidth="8" fill="none"
                strokeDasharray={2*Math.PI*68*SCORE/100+" "+2*Math.PI*68}
                strokeLinecap="round" strokeDashoffset={2*Math.PI*68*0.25}
                style={{ filter:"drop-shadow(0 0 12px "+SB+")" }}/>
              {/* Inner ring */}
              <circle cx="80" cy="80" r="54" stroke={SB+"22"} strokeWidth="1" fill="none"/>
              <text x="80" y="72"  textAnchor="middle" fill={SB}    fontSize="34" fontWeight="900" fontFamily="inherit">{SCORE}</text>
              <text x="80" y="90"  textAnchor="middle" fill={T.muted}fontSize="11" fontFamily="inherit">SHIELD SCORE</text>
              <text x="80" y="106" textAnchor="middle" fill={T.green}fontSize="10" fontWeight="700" fontFamily="inherit">PROTECTED</text>
            </svg>
            <div style={{ position:"absolute", bottom:6, right:6, width:16, height:16, borderRadius:"50%", background:T.green, boxShadow:"0 0 10px "+T.green, animation:"pd 1.5s ease-in-out infinite" }}/>
          </div>

          {/* Stats grid */}
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14, marginBottom:20 }}>
              {[
                { label:"Documents Protected", value:"5",      icon:"🔒", col:SB      },
                { label:"Contracts Locked",    value:"2",      icon:"📜", col:T.green  },
                { label:"Access Events Today", value:"14",     icon:"👁",  col:T.blue   },
                { label:"Threats Blocked",     value:"1",      icon:"🚨", col:T.red    },
                { label:"Users Monitored",     value:"6",      icon:"👥", col:T.amber  },
                { label:"Audit Log Entries",   value:"284",    icon:"📋", col:SB      },
              ].map(s => (
                <div key={s.label} style={{ background:T.surface, borderRadius:10, padding:"12px 14px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <p style={{ color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", margin:"0 0 4px" }}>{s.label}</p>
                      <p style={{ color:s.col, fontSize:22, fontWeight:900, margin:0 }}>{s.value}</p>
                    </div>
                    <span style={{ fontSize:18, opacity:.7 }}>{s.icon}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Live scan animation */}
            <div style={{ background:T.surface, borderRadius:10, padding:"10px 14px", display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:scanning?T.amber:T.green, animation:scanning?"pd .6s ease-in-out infinite":"pd 2s ease-in-out infinite", flexShrink:0 }}/>
              <p style={{ color:T.muted, fontSize:12, margin:0, flex:1 }}>
                {scanning
                  ? ["🔍 Scanning document hashes…","🔍 Checking access patterns…","🔍 Verifying permission matrix…"][tick3]
                  : scanned
                  ? "✅ Security scan complete — 1 tamper alert, 1 failed login blocked. All other systems normal."
                  : "🛡 SHIELD™ is actively monitoring your platform. Last full scan: Today 06:00 AM."}
              </p>
              {scanning && <span style={{ color:T.amber, fontSize:11, fontWeight:700, flexShrink:0 }}>SCANNING</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:20, borderBottom:"1px solid "+T.border }}>
        {["Overview","Audit Trail","Documents","Permissions","Threats"].map(t => {
          const k = t.toLowerCase().replace(" ","_");
          const a = tab===k;
          return (
            <button key={t} onClick={() => setTab(k)}
              style={{ background:"transparent", border:"none", borderBottom:a?"2px solid "+SB:"2px solid transparent", color:a?SB:T.muted, fontWeight:a?700:400, fontSize:13, padding:"8px 20px", cursor:"pointer", fontFamily:"inherit", marginBottom:-1, transition:"all .15s" }}>
              {t}
            </button>
          );
        })}
      </div>

      {/* OVERVIEW */}
      {tab==="overview" && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
          <Card>
            <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 16px", fontSize:14 }}>Security Health Metrics</h3>
            {SECURITY_METRICS.map((m,i) => (
              <div key={i} style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
                  <span style={{ color:T.textSoft, fontSize:12 }}>{m.label}</span>
                  <span style={{ color:m.col, fontSize:13, fontWeight:700 }}>{m.score}/100</span>
                </div>
                <ProgBar val={m.score} color={m.col} h={5} />
                <p style={{ color:T.muted, fontSize:11, margin:"4px 0 0", lineHeight:1.4 }}>{m.detail}</p>
              </div>
            ))}
          </Card>

          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            <Card>
              <h3 style={{ color:T.text, fontWeight:700, margin:"0 0 14px", fontSize:14 }}>Recent Threats & Alerts</h3>
              {THREATS.map((t2,i) => (
                <div key={i} style={{ padding:"10px 12px", background:T.bg, borderRadius:9, marginBottom:8, borderLeft:"3px solid "+(threatCol[t2.level]||T.muted) }}>
                  <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
                    <span style={{ fontSize:14, flexShrink:0 }}>{t2.icon}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:2 }}>
                        <span style={{ color:threatCol[t2.level]||T.muted, fontSize:12, fontWeight:700 }}>{t2.level} · {t2.title}</span>
                        <span style={{ color:T.muted, fontSize:10 }}>{t2.time}</span>
                      </div>
                      <p style={{ color:T.textSoft, fontSize:11, margin:0, lineHeight:1.5 }}>{t2.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </Card>

            <Card style={{ background:"linear-gradient(135deg,"+T.surface+",#050E1A)", border:"1px solid "+SB+"33" }}>
              <h3 style={{ color:SB, fontWeight:800, margin:"0 0 12px", fontSize:14 }}>🛡 What SHIELD™ Protects</h3>
              {[
                "Tamper-evident document hashing — every file fingerprinted",
                "Cryptographic contract locking — locked versions cannot be altered",
                "Full audit trail — every view, edit, export and delete logged",
                "Role-based access enforcement — right people, right documents",
                "Brute-force login detection — attacks blocked automatically",
                "AES-256 encryption at rest and in transit",
                "Digital signature workflow — sign contracts inside the platform",
                "Anomaly detection — unusual access patterns flagged instantly",
              ].map((f,i) => (
                <div key={i} style={{ display:"flex", gap:8, marginBottom:8 }}>
                  <span style={{ color:SB, fontSize:11, flexShrink:0, marginTop:2 }}>✓</span>
                  <span style={{ color:T.textSoft, fontSize:12 }}>{f}</span>
                </div>
              ))}
              <div style={{ marginTop:12, padding:"8px 12px", background:SB+"12", borderRadius:8 }}>
                <p style={{ color:SB, fontSize:11, fontWeight:700, margin:0 }}>🔒 Constrapp SHIELD™ is an original Constrapp security system. Patent-pending. Exclusive to this platform.</p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* AUDIT TRAIL */}
      {tab==="audit_trail" && (
        <Card style={{ padding:0, overflow:"hidden" }}>
          <div style={{ padding:"14px 18px", borderBottom:"1px solid "+T.border, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Tamper-Evident Audit Trail</h3>
            <div style={{ display:"flex", gap:8 }}>
              <span style={{ color:T.muted, fontSize:12 }}>284 events logged · all immutable</span>
              <Btn variant="ghost" sm>⬇ Export Log</Btn>
            </div>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ background:T.card }}>
                {["Time","User","Role","Action","Document","IP Address","Status"].map(h => (
                  <th key={h} style={{ textAlign:"left", padding:"9px 14px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", borderBottom:"1px solid "+T.border }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ACCESS_LOG.map((e,i) => {
                const sc = e.status==="Alert" ? T.red : e.status==="Protected" ? SB : e.status==="Logged" ? T.amber : T.green;
                return (
                  <tr key={i} style={{ borderBottom:"1px solid "+T.border }}
                    onMouseEnter={el => el.currentTarget.style.background=T.card}
                    onMouseLeave={el => el.currentTarget.style.background="transparent"}>
                    <td style={{ padding:"11px 14px", color:T.muted, fontSize:11, whiteSpace:"nowrap" }}>{e.time}</td>
                    <td style={{ padding:"11px 14px", color:T.text, fontSize:12, fontWeight:600 }}>{e.user}</td>
                    <td style={{ padding:"11px 14px", color:T.muted, fontSize:11 }}>{e.role}</td>
                    <td style={{ padding:"11px 14px", color:T.textSoft, fontSize:12 }}>{e.action}</td>
                    <td style={{ padding:"11px 14px", color:T.muted, fontSize:11, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{e.doc}</td>
                    <td style={{ padding:"11px 14px", color:T.muted, fontSize:11, fontFamily:"monospace" }}>{e.ip}</td>
                    <td style={{ padding:"11px 14px" }}>
                      <span style={{ background:sc+"22", color:sc, border:"1px solid "+sc+"44", borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700 }}>{e.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* DOCUMENTS */}
      {tab==="documents" && (
        <Card>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Document Integrity & Contract Locking</h3>
            <span style={{ color:T.muted, fontSize:12 }}>SHA-256 hash fingerprinting · tamper-evident</span>
          </div>
          {DOCUMENTS.map((doc,i) => (
            <div key={i} style={{ padding:"14px 16px", background:doc.tamper?T.red+"0A":T.bg, border:"1px solid "+(doc.tamper?T.red+"44":T.border), borderRadius:10, marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                    <span style={{ fontSize:16 }}>{doc.locked?"🔒":"📄"}</span>
                    <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>{doc.name}</span>
                    {doc.tamper && <span style={{ background:T.red+"22", color:T.red, border:"1px solid "+T.red+"44", borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700 }}>⚠ TAMPER DETECTED</span>}
                    {doc.locked && <span style={{ background:SB+"22", color:SB, border:"1px solid "+SB+"44", borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700 }}>🔒 Locked {doc.ver}</span>}
                  </div>
                  <div style={{ display:"flex", gap:20 }}>
                    <span style={{ color:T.muted, fontSize:11 }}>Hash: <span style={{ fontFamily:"monospace", color:doc.tamper?T.red:T.textSoft }}>{doc.hash}</span></span>
                    <span style={{ color:T.muted, fontSize:11 }}>Signed: {doc.signed}</span>
                    <span style={{ color:T.muted, fontSize:11 }}>Version: {doc.ver}</span>
                  </div>
                </div>
                <div style={{ display:"flex", gap:7, flexShrink:0 }}>
                  {!doc.locked && <Btn sm style={{ background:"linear-gradient(90deg,"+SB+",#0099CC)", color:"#000" }}>🔒 Lock</Btn>}
                  {!doc.verified && <Btn sm style={{ background:"#00C9A718", color:T.accent, border:"1px solid #00C9A740" }}>✍ Sign</Btn>}
                  {doc.tamper && <Btn variant="danger" sm>⚠ Investigate</Btn>}
                  <Btn variant="ghost" sm>History</Btn>
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* PERMISSIONS */}
      {tab==="permissions" && (
        <Card style={{ padding:0, overflow:"hidden" }}>
          <div style={{ padding:"14px 18px", borderBottom:"1px solid "+T.border }}>
            <h3 style={{ color:T.text, fontWeight:700, margin:0, fontSize:14 }}>Role-Based Access Control Matrix</h3>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ background:T.card }}>
                {["Role","View Docs","Edit Docs","Delete Docs","Export","Sign Contracts","Lock Contracts"].map(h => (
                  <th key={h} style={{ textAlign:"left", padding:"10px 14px", color:T.muted, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:".4px", borderBottom:"1px solid "+T.border }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map((p,i) => {
                const Cell = ({ val }) => (
                  <td style={{ padding:"13px 14px" }}>
                    <span style={{ fontSize:16 }}>{val ? "✅" : "🚫"}</span>
                  </td>
                );
                return (
                  <tr key={i} style={{ borderBottom:"1px solid "+T.border }}
                    onMouseEnter={e => e.currentTarget.style.background=T.card}
                    onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                    <td style={{ padding:"13px 14px", color:T.text, fontSize:13, fontWeight:700 }}>{p.role}</td>
                    <Cell val={p.canView} />
                    <Cell val={p.canEdit} />
                    <Cell val={p.canDelete} />
                    <Cell val={p.canExport} />
                    <Cell val={p.canSign} />
                    <Cell val={p.canLock} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* THREATS */}
      {tab==="threats" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ background:T.surface, border:"1px solid "+SB+"33", borderRadius:12, padding:18, display:"flex", alignItems:"center", gap:16 }}>
            <div style={{ width:52, height:52, borderRadius:"50%", background:T.green+"22", border:"2px solid "+T.green+"55", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>🛡</div>
            <div>
              <p style={{ color:T.green, fontSize:14, fontWeight:800, margin:0 }}>Platform Secure — 1 active alert</p>
              <p style={{ color:T.muted, fontSize:12, margin:"3px 0 0" }}>SHIELD™ is actively monitoring. All critical systems operational. 1 failed login blocked in last 7 days.</p>
            </div>
          </div>
          {THREATS.map((t2,i) => (
            <div key={i} style={{ background:T.surface, border:"1px solid "+(threatCol[t2.level]||T.muted)+"44", borderRadius:12, padding:18 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
                  <div style={{ width:42, height:42, borderRadius:10, background:(threatCol[t2.level]||T.muted)+"22", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{t2.icon}</div>
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                      <span style={{ color:threatCol[t2.level]||T.muted, fontSize:13, fontWeight:800 }}>{t2.level}</span>
                      <span style={{ color:T.text, fontSize:13, fontWeight:600 }}>{t2.title}</span>
                    </div>
                    <p style={{ color:T.textSoft, fontSize:12, margin:0, lineHeight:1.6 }}>{t2.detail}</p>
                    <p style={{ color:T.muted, fontSize:11, margin:"4px 0 0" }}>{t2.time}</p>
                  </div>
                </div>
                <div style={{ display:"flex", gap:7, flexShrink:0 }}>
                  {t2.level==="High"   && <Btn variant="danger" sm>Investigate</Btn>}
                  {t2.level==="Medium" && <Btn variant="ghost"  sm>Review</Btn>}
                  <Btn variant="ghost" sm>Dismiss</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function renderPage(page, user, company) {
  if(page==="dashboard")       return <Dashboard user={user} company={company} />;
  if(page==="projects")        return <Projects  company={company} />;
  if(page==="boq")             return <BOQ />;
  if(page==="budgets")         return <Budgets company={company} user={user} />;
  if(page==="forecasting")     return <Forecasting company={company} />;
  if(page==="contacts")        return <Contacts    company={company} />;
  if(page==="drawings")        return <Drawings />;
  if(page==="purchase_orders") return <PurchaseOrders />;
  if(page==="qs_takeoff")      return <QSTakeoff />;
  if(page==="subcontractors")  return <Subcontractors />;
  if(page==="pulse")           return <Pulse company={company} />;
  if(page==="shield")          return <Shield user={user} company={company} />;
  if(page==="timeline")        return <Timeline company={company} />;
  if(page==="photos")          return <Photos   company={company} />;
  if(page==="reports")         return <Reports  company={company} />;
  if(page==="billing")         return <Billing />;
  return <Dashboard user={user} company={company} />;
}

export default function App() {
  const [user,    setUser]    = useState(null);
  const [company, setCompany] = useState(null);
  const [page,    setPage]    = useState("dashboard");

  if(!user) return <Login onLogin={(u,c) => { setUser(u); setCompany(c); }} />;

  return (
    <div style={{ display:"flex", height:"100vh", background:T.bg, fontFamily:"'Sora','DM Sans','Segoe UI',sans-serif", color:T.text, overflow:"hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#1E3248; border-radius:99px; }
        input[type=range] { height:4px; border-radius:99px; outline:none; border:none; cursor:pointer; }
        button:focus { outline:none; }
        @keyframes pd { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:1;transform:scale(1.35)} }
      `}</style>

      <Sidebar page={page} onNav={setPage} user={user} company={company} onSwitchCo={c => setCompany(c)} />

      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <TopBar user={user} company={company} page={page} onLogout={() => { setUser(null); setCompany(null); setPage("dashboard"); }} />
        <div style={{ flex:1, overflowY:"auto" }}>
          {renderPage(page, user, company)}
        </div>
      </div>
    </div>
  );
}
