const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { nanoid } = require('nanoid');
const { Pool } = require('pg');
let multer;
try { multer = require('multer'); } catch(e) { multer = null; }

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const HAS_POSTGRES = !!process.env.DATABASE_URL;
const pool = HAS_POSTGRES ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : { single: () => (req,res,next) => next(new Error('مكتبات رفع الملفات غير مثبتة. حدّث package.json ثم اعمل Redeploy.')) };

function ensureFileDb(){
  if(!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true });
  if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], exams: [], results: [] }, null, 2));
}
function readFileDb(){ ensureFileDb(); const d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); d.users=d.users||[]; d.exams=d.exams||[]; d.results=d.results||[]; return d; }
function writeFileDb(d){ fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }
async function initDb(){
  if(!HAS_POSTGRES){ ensureFileDb(); return; }
  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists exams (
      id text primary key,
      owner_id text not null references users(id) on delete cascade,
      title text not null,
      slug text unique not null,
      published boolean not null default false,
      questions jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );
    create table if not exists results (
      id text primary key,
      exam_id text not null,
      owner_id text not null,
      owner_email text,
      exam_title text not null,
      student_name text not null,
      score int not null,
      total int not null,
      percent int not null,
      answers jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
}

const store = {
  async getUserById(id){
    if(HAS_POSTGRES){ const r=await pool.query('select id,email,password_hash as "passwordHash",created_at as "createdAt" from users where id=$1',[id]); return r.rows[0]||null; }
    return readFileDb().users.find(u=>u.id===id)||null;
  },
  async getUserByEmail(email){
    if(HAS_POSTGRES){ const r=await pool.query('select id,email,password_hash as "passwordHash",created_at as "createdAt" from users where email=$1',[email]); return r.rows[0]||null; }
    return readFileDb().users.find(u=>u.email===email)||null;
  },
  async createUser(user){
    if(HAS_POSTGRES){ await pool.query('insert into users(id,email,password_hash,created_at) values($1,$2,$3,$4)',[user.id,user.email,user.passwordHash,user.createdAt]); return; }
    const d=readFileDb(); d.users.push(user); writeFileDb(d);
  },
  async updateUserEmail(id,email){
    if(HAS_POSTGRES){ await pool.query('update users set email=$1 where id=$2',[email,id]); return; }
    const d=readFileDb(); const u=d.users.find(x=>x.id===id); if(u) u.email=email; writeFileDb(d);
  },
  async listExams(ownerId){
    if(HAS_POSTGRES){ const r=await pool.query('select id,owner_id as "ownerId",title,slug,published,questions,created_at as "createdAt" from exams where owner_id=$1 order by created_at desc',[ownerId]); return r.rows; }
    return readFileDb().exams.filter(e=>e.ownerId===ownerId).reverse();
  },
  async getExamById(id){
    if(HAS_POSTGRES){ const r=await pool.query('select id,owner_id as "ownerId",title,slug,published,questions,created_at as "createdAt" from exams where id=$1',[id]); return r.rows[0]||null; }
    return readFileDb().exams.find(e=>e.id===id)||null;
  },
  async getExamBySlug(slug){
    if(HAS_POSTGRES){ const r=await pool.query('select id,owner_id as "ownerId",title,slug,published,questions,created_at as "createdAt" from exams where slug=$1',[slug]); return r.rows[0]||null; }
    return readFileDb().exams.find(e=>e.slug===slug)||null;
  },
  async slugExists(slug){ return !!(await this.getExamBySlug(slug)); },
  async createExam(exam){
    if(HAS_POSTGRES){ await pool.query('insert into exams(id,owner_id,title,slug,published,questions,created_at) values($1,$2,$3,$4,$5,$6,$7)',[exam.id,exam.ownerId,exam.title,exam.slug,exam.published,JSON.stringify(exam.questions),exam.createdAt]); return; }
    const d=readFileDb(); d.exams.push(exam); writeFileDb(d);
  },
  async updateExam(exam){
    if(HAS_POSTGRES){ await pool.query('update exams set title=$1, slug=$2, published=$3, questions=$4 where id=$5',[exam.title,exam.slug,exam.published,JSON.stringify(exam.questions),exam.id]); return; }
    const d=readFileDb(); const i=d.exams.findIndex(e=>e.id===exam.id); if(i>=0)d.exams[i]=exam; writeFileDb(d);
  },
  async deleteExam(id, ownerId){
    if(HAS_POSTGRES){ await pool.query('delete from results where exam_id=$1 and owner_id=$2',[id,ownerId]); await pool.query('delete from exams where id=$1 and owner_id=$2',[id,ownerId]); return; }
    const d=readFileDb(); d.exams=d.exams.filter(e=>!(e.id===id&&e.ownerId===ownerId)); d.results=d.results.filter(r=>r.examId!==id); writeFileDb(d);
  },
  async addResult(result){
    if(HAS_POSTGRES){ await pool.query('insert into results(id,exam_id,owner_id,owner_email,exam_title,student_name,score,total,percent,answers,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[result.id,result.examId,result.ownerId,result.ownerEmail,result.examTitle,result.studentName,result.score,result.total,result.percent,JSON.stringify(result.answers),result.createdAt]); return; }
    const d=readFileDb(); d.results.push(result); writeFileDb(d);
  },
  async listResults(ownerId){
    if(HAS_POSTGRES){ const r=await pool.query('select id, exam_id as "examId", owner_id as "ownerId", owner_email as "ownerEmail", exam_title as "examTitle", student_name as "studentName", score,total,percent,answers,created_at as "createdAt" from results where owner_id=$1 order by created_at desc',[ownerId]); return r.rows; }
    return readFileDb().results.filter(r=>r.ownerId===ownerId).reverse();
  },
  async deleteResult(id, ownerId){
    if(HAS_POSTGRES){ await pool.query('delete from results where id=$1 and owner_id=$2',[id,ownerId]); return; }
    const d=readFileDb(); d.results=d.results.filter(r=>!(r.id===id && r.ownerId===ownerId)); writeFileDb(d);
  },
  async deleteAllResults(ownerId){
    if(HAS_POSTGRES){ await pool.query('delete from results where owner_id=$1',[ownerId]); return; }
    const d=readFileDb(); d.results=d.results.filter(r=>r.ownerId!==ownerId); writeFileDb(d);
  }
};

function asyncRoute(fn){ return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next); }
function esc(s=''){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function encodeNonAscii(html=''){ return Array.from(String(html)).map(ch => ch.codePointAt(0) > 127 ? '&#' + ch.codePointAt(0) + ';' : ch).join(''); }

function icon(name){
  const icons={
    home:'<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/></svg>',
    plus:'<svg viewBox="0 0 24 24"><path d="M11 4h2v16h-2zM4 11h16v2H4z"/></svg>',
    chart:'<svg viewBox="0 0 24 24"><path d="M4 19h16v2H4zM6 10h3v7H6zM11 4h3v13h-3zM16 7h3v10h-3z"/></svg>',
    user:'<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5Zm0 2c-5 0-9 2.5-9 5.5V22h18v-2.5C21 16.5 17 14 12 14Z"/></svg>',
    logout:'<svg viewBox="0 0 24 24"><path d="M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6v-2H5V5h5V3Zm4.7 4.3-1.4 1.4L15.6 11H8v2h7.6l-2.3 2.3 1.4 1.4L19.4 12Z"/></svg>',
    copy:'<svg viewBox="0 0 24 24"><path d="M8 7h11v14H8z"/><path d="M5 3h11v2H7v12H5z"/></svg>',
    edit:'<svg viewBox="0 0 24 24"><path d="M4 17.5V21h3.5L18.1 10.4l-3.5-3.5L4 17.5ZM20.7 7.8a1 1 0 0 0 0-1.4l-3.1-3.1a1 1 0 0 0-1.4 0l-1.5 1.5 4.5 4.5z"/></svg>',
    rocket:'<svg viewBox="0 0 24 24"><path d="M12 2c3.5.4 6.6 3.5 7 7-2.4.7-4.5 2-6.1 3.9L11 15l-2-2 2.1-1.9C13 9.5 14.3 7.4 15 5c-2.4.7-4.5 2-6.1 3.9L7 11 5 9l2.1-1.9C8.7 5.2 10 3 12 2ZM5 14c-1.6 1-2.6 2.8-3 5 2.2-.4 4-1.4 5-3zM16 15l3 3-1.5 1.5-3-3z"/></svg>',
    trash:'<svg viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7zM9 4h6l1 2H8zM4 6h16v2H4z"/></svg>',
    brain:'<svg viewBox="0 0 24 24"><path d="M9 3a4 4 0 0 0-4 4v1a4 4 0 0 0 0 8v1a4 4 0 0 0 7 2.6A4 4 0 0 0 19 17v-1a4 4 0 0 0 0-8V7a4 4 0 0 0-7-2.6A4 4 0 0 0 9 3Zm3 4h2v3h3v2h-3v3h-2v-3H9v-2h3z"/></svg>',
    link:'<svg viewBox="0 0 24 24"><path d="M8 12a4 4 0 0 1 4-4h3v2h-3a2 2 0 0 0 0 4h3v2h-3a4 4 0 0 1-4-4Zm1 1h6v-2H9zm3-5h-3V6h3a6 6 0 0 1 0 12H9v-2h3a4 4 0 0 0 0-8Z"/></svg>',
    save:'<svg viewBox="0 0 24 24"><path d="M5 3h12l2 2v16H5zM7 5v5h8V5zm1 11h8v3H8z"/></svg>'
  };
  return '<span class="ico">'+(icons[name]||icons.home)+'</span>';
}

function layout(title, body){
  const css = `
:root{--bgA:#070b1a;--bgB:#111827;--glass:#ffffffd9;--glass2:#ffffff1f;--text:#0f172a;--muted:#64748b;--primary:#7c3aed;--cyan:#06b6d4;--pink:#ec4899;--green:#22c55e;--danger:#ef4444;--warning:#f59e0b;--border:#e2e8f0;--shadow:0 22px 60px #02061740;--r:24px}*{box-sizing:border-box}html{min-height:100%;scroll-behavior:smooth}body{margin:0;font-family:Tahoma,Arial,sans-serif;color:var(--text);direction:rtl;min-height:100vh;background:radial-gradient(circle at 80% 10%,#312e81 0,#111827 32%,#020617 100%);overflow-x:hidden}.ai-bg{position:fixed;inset:0;z-index:-3;overflow:hidden}.orb{position:absolute;width:42vw;max-width:520px;height:42vw;max-height:520px;border-radius:50%;filter:blur(42px);opacity:.38;animation:orb 16s ease-in-out infinite}.orb.a{background:#06b6d4;right:-10%;top:-10%}.orb.b{background:#8b5cf6;left:-12%;bottom:-12%;animation-delay:-5s}.orb.c{background:#ec4899;right:25%;bottom:12%;animation-delay:-9s}.grid-bg{position:fixed;inset:0;z-index:-2;background-image:linear-gradient(#ffffff12 1px,transparent 1px),linear-gradient(90deg,#ffffff12 1px,transparent 1px);background-size:44px 44px;mask-image:linear-gradient(to bottom,#000,transparent 75%);animation:gridmove 18s linear infinite}@keyframes gridmove{to{transform:translateY(44px)}}@keyframes orb{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(55px,35px,0) scale(1.16)}}.container{max-width:1120px;margin:auto;padding:22px 16px 92px}.card{position:relative;background:var(--glass);backdrop-filter:blur(18px);border:1px solid #ffffffb3;border-radius:var(--r);padding:22px;margin:18px 0;box-shadow:var(--shadow);animation:rise .42s cubic-bezier(.2,.9,.2,1) both;overflow:hidden}.card:before{content:"";position:absolute;inset:0 0 auto 0;height:4px;background:linear-gradient(90deg,var(--cyan),var(--primary),var(--pink));opacity:.9}.card:hover{transform:translateY(-4px);box-shadow:0 28px 75px #02061766}.btn:active,.nav a:active{transform:scale(.96)}@keyframes rise{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}h1{font-size:clamp(28px,6vw,48px);line-height:1.15;margin:12px 0 20px;color:#fff;text-shadow:0 12px 35px #0008}h2,h3{margin-top:0}.card h1,.card h2,.card h3{color:#111827;text-shadow:none}.muted{color:var(--muted)}a{color:#2563eb;text-decoration:none;font-weight:800}.nav{position:sticky;top:8px;z-index:20;display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px;background:#ffffff22;border:1px solid #ffffff55;border-radius:22px;padding:10px;backdrop-filter:blur(20px);box-shadow:0 12px 30px #0002}.nav a,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,var(--primary),var(--cyan));color:#fff;border:none;border-radius:16px;padding:12px 16px;cursor:pointer;font-size:15px;font-weight:900;box-shadow:0 12px 26px #0002;transition:.22s;min-height:46px}.nav a:hover,.btn:hover{transform:translateY(-3px);filter:saturate(1.18)}.btn.secondary{background:linear-gradient(135deg,#334155,#64748b)}.btn.danger{background:linear-gradient(135deg,#dc2626,#fb7185)}.btn.ok{background:linear-gradient(135deg,#16a34a,#22c55e)}.ico{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;flex:0 0 20px}.ico svg{width:20px;height:20px;fill:currentColor;animation:iconPulse 2.8s ease-in-out infinite}@keyframes iconPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12) rotate(-2deg)}}input,textarea,select{width:100%;padding:14px;border:1px solid var(--border);border-radius:16px;margin:7px 0 15px;font-size:16px;background:#fff;outline:none;transition:.22s;min-height:48px}input:focus,textarea:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 5px #7c3aed22}textarea{min-height:110px;resize:vertical}label{font-weight:900}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.option{display:flex;gap:10px;align-items:center;padding:12px;border:1px solid #e5e7eb;border-radius:16px;margin:9px 0;background:#f8fafc;transition:.2s;cursor:pointer}.option:hover{background:#eef2ff;transform:translateX(-2px)}.option input[type=radio]{width:auto;margin:0;min-height:auto}.table{width:100%;border-collapse:separate;border-spacing:0 9px;overflow:auto}.table th{color:#475569}.table th,.table td{padding:12px;text-align:right;vertical-align:middle}.table tr{background:#f8fafc}.table td:first-child,.table th:first-child{border-radius:0 16px 16px 0}.table td:last-child,.table th:last-child{border-radius:16px 0 0 16px}.badge{display:inline-flex;align-items:center;gap:6px;background:#ede9fe;color:#6d28d9;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:900}.notice{padding:14px;border-radius:16px;background:#ecfeff;border:1px solid #a5f3fc}.error{padding:14px;border-radius:16px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.ltr{direction:ltr;text-align:left}.small{font-size:13px}.question{border-top:1px solid var(--border);padding-top:16px;margin-top:16px}.linkbox{background:#eef2ff;border:1px dashed #818cf8;border-radius:18px;padding:14px;word-break:break-all;line-height:1.7}.ai-panel{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.ai-tip{background:linear-gradient(135deg,#fff,#eff6ff);border:1px solid #dbeafe;border-radius:18px;padding:14px;font-weight:800}.footer{margin:28px auto 8px;text-align:center;color:#fff;font-size:15px;font-weight:900;border:1px solid #ffffff66;background:linear-gradient(135deg,#ffffff22,#ffffff0f);backdrop-filter:blur(18px);border-radius:22px;padding:13px 20px;max-width:390px;box-shadow:0 18px 45px #0005;animation:rise .6s ease both}.footer b{color:#67e8f9}.shine{position:relative;overflow:hidden}.shine:after{content:'';position:absolute;inset:-80% auto auto -30%;width:35%;height:260%;background:linear-gradient(90deg,transparent,#fff8,transparent);transform:rotate(25deg);animation:shine 3.2s ease-in-out infinite}@keyframes shine{0%,55%{left:-40%}100%{left:120%}}.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#111827;color:#fff;padding:12px 18px;border-radius:999px;box-shadow:var(--shadow);z-index:80;display:none}.bottom-nav{display:none}@media(max-width:720px){.container{padding:12px 10px 98px}.card{padding:16px;border-radius:20px;margin:14px 0}.nav{display:none}.bottom-nav{position:fixed;bottom:10px;left:10px;right:10px;z-index:60;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;background:#0f172acc;border:1px solid #ffffff38;border-radius:22px;padding:9px;backdrop-filter:blur(18px);box-shadow:0 16px 40px #0006}.bottom-nav a{display:flex;flex-direction:column;align-items:center;gap:4px;color:#fff;text-decoration:none;font-size:11px;font-weight:900}.bottom-nav .ico{width:22px;height:22px}.row,.row form{width:100%}.row .btn,.row a.btn,.row form button{width:100%}.table{display:block;overflow-x:auto;white-space:nowrap}input,textarea,select{font-size:16px}.btn{width:100%}}
`;
  const js = `<script>var audioCtx;function beep(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=620;g.gain.setValueAtTime(.04,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.09);o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+.1)}catch(e){}}document.addEventListener('click',function(e){var el=e.target.closest('button,.btn,a');if(el)beep();});function copyLink(t){beep();navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){toast('تم نسخ رابط الامتحان')}).catch(function(){prompt('انسخ الرابط',t)})}function toast(t){var e=document.getElementById('toast');if(!e)return;e.textContent=t;e.style.display='block';setTimeout(function(){e.style.display='none'},1800)}function go(url){location.href=url}</script>`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><style>${css}</style></head><body><div class="ai-bg"><div class="orb a"></div><div class="orb b"></div><div class="orb c"></div></div><div class="grid-bg"></div><main class="container">${body}<footer class="footer shine">تم التطوير بواسطة <b>ahmed</b>😎</footer></main><div id="toast" class="toast"></div>${js}</body></html>`;
  return encodeNonAscii(html);
}
function adminNav(req){ return `<div class="nav"><a href="/admin">${icon('home')} الرئيسية</a><a href="/admin/exams/new">${icon('plus')} امتحان جديد</a><a href="/admin/results">${icon('chart')} النتائج</a><a href="/admin/account">${icon('user')} حسابي</a><a class="btn secondary" href="/admin/logout">${icon('logout')} خروج</a></div><nav class="bottom-nav"><a href="/admin">${icon('home')}<span>الرئيسية</span></a><a href="/admin/exams/new">${icon('plus')}<span>امتحان</span></a><a href="/admin/results">${icon('chart')}<span>النتائج</span></a><a href="/admin/account">${icon('user')}<span>حسابي</span></a></nav><p class="muted small">مسجل دخول: ${esc(req.session.userEmail || '')}</p>`; }
async function requireUser(req,res,next){ const u = req.session.userId ? await store.getUserById(req.session.userId) : null; if(u){ req.user=u; return next(); } res.redirect(303, '/admin/login'); }
function slugify(s){ return String(s||'exam').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-\u0600-\u06FF]/g,'').slice(0,60) || nanoid(6); }
function normalizeEmail(email){ return String(email || '').trim().toLowerCase(); }
function publicBaseUrl(req){ const proto=String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]; return `${proto}://${req.headers.host}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){ const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex'); return `${salt}:${hash}`; }
function verifyPassword(password, stored){ if(!stored || !stored.includes(':')) return false; const [salt, oldHash] = stored.split(':'); const newHash = hashPassword(password, salt).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(oldHash), Buffer.from(newHash)); }
function getMailer(){ if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null; return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }); }
async function notifyResult({ examTitle, studentName, score, total, percent, ownerEmail }){ const mailer=getMailer(); if(!mailer||!ownerEmail) return; await mailer.sendMail({ from:process.env.MAIL_FROM||process.env.SMTP_USER, to:ownerEmail, subject:`نتيجة جديدة: ${studentName} - ${examTitle}`, text:`الاسم: ${studentName}\nالامتحان: ${examTitle}\nالدرجة: ${score}/${total}\nالنسبة: ${percent}%\nالوقت: ${new Date().toLocaleString('ar-EG')}\n\nتم التطوير بواسطة ahmed` }); }


function cleanHeader(v){ return String(v||'').trim().toLowerCase().replace(/\s+/g,'').replace(/[اأإآ]/g,'ا').replace(/ة/g,'ه'); }
function getCell(row, names){
  const keys = Object.keys(row);
  for(const name of names){ const n=cleanHeader(name); const k=keys.find(x=>cleanHeader(x)===n); if(k && row[k]!==undefined && row[k]!==null && String(row[k]).trim()!=='') return String(row[k]).trim(); }
  return '';
}
function rowToQuestion(row, idx){
  const text = getCell(row, ['question','السؤال','سؤال','نص السؤال']);
  const options = [
    getCell(row, ['option1','اختيار1','الاختيار1','اجابة1','إجابة1','a','أ']),
    getCell(row, ['option2','اختيار2','الاختيار2','اجابة2','إجابة2','b','ب']),
    getCell(row, ['option3','اختيار3','الاختيار3','اجابة3','إجابة3','c','ج']),
    getCell(row, ['option4','اختيار4','الاختيار4','اجابة4','إجابة4','d','د'])
  ].filter(Boolean);
  const correctRaw = getCell(row, ['correct','answer','الاجابة الصحيحة','الإجابة الصحيحة','الصحيح','رقم الاجابة','رقم الإجابة']);
  const pointsRaw = getCell(row, ['points','degree','score','الدرجة','درجه']);
  if(!text && options.length===0) return null;
  if(!text || options.length<2) throw new Error(`صف ${idx+2}: لازم سؤال واختيارين على الأقل`);
  let correctIndex = correctIndexFrom(correctRaw, options);
  const points = Math.max(1, Number(pointsRaw || 1) || 1);
  return { id:nanoid(8), text, options, correctIndex, points };
}
function correctIndexFrom(raw, options){
  const c = String(raw||'1').trim();
  const map = {'أ':0,'ا':0,'a':0,'A':0,'ب':1,'b':1,'B':1,'ج':2,'c':2,'C':2,'د':3,'d':3,'D':3};
  if(/^[1-4]$/.test(c)) return Math.min(Number(c)-1, options.length-1);
  if(map[c] !== undefined) return Math.min(map[c], options.length-1);
  const found = options.findIndex(o => String(o).trim() === c);
  return found >= 0 ? found : 0;
}
function parseQuestionsFromExcel(buffer){
  let XLSX; try { XLSX = require('xlsx'); } catch(e) { throw new Error('مكتبة Excel غير مثبتة. حدّث package.json ثم اعمل Redeploy.'); }
  const workbook = XLSX.read(buffer, { type:'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval:'' });
  const questions=[];
  rows.forEach((row, idx)=>{ const q=rowToQuestion(row, idx); if(q) questions.push(q); });
  return questions;
}
function parseDelimitedText(text){
  const lines = String(text||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(lines.length < 2) return [];
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
  const headers = lines[0].split(sep).map(x=>x.trim());
  const questions=[];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split(sep).map(x=>x.trim());
    const row={}; headers.forEach((h,j)=>row[h]=cols[j]||'');
    const q=rowToQuestion(row, i-1); if(q) questions.push(q);
  }
  return questions;
}
function parseBlocksText(text){
  const t = String(text||'').replace(/\r/g,'').replace(/[\u200f\u200e]/g,'');
  const lines = t.split('\n').map(x=>x.trim()).filter(Boolean);
  const blocks=[]; let cur=[];
  for(const line of lines){
    if(/^\s*(س\s*)?\d+[\).\-:\s]/.test(line) && cur.length){ blocks.push(cur); cur=[line]; }
    else cur.push(line);
  }
  if(cur.length) blocks.push(cur);
  const questions=[];
  const optRe=/^(?:[\(\[]?\s*([1-4]|[A-Da-d]|[أابجدد])\s*[\)\].\-:])\s*(.+)$/;
  blocks.forEach((b, bi)=>{
    let question=''; const options=[]; let correct=''; let points=1;
    b.forEach(line=>{
      const ans=line.match(/(?:الإجابة|الاجابة|الصحيح|answer|correct)\s*[:：\-]?\s*(.+)$/i);
      if(ans){ correct=ans[1].trim(); return; }
      const deg=line.match(/(?:الدرجة|درجه|points|score)\s*[:：\-]?\s*(\d+)/i);
      if(deg){ points=Number(deg[1])||1; return; }
      const opt=line.match(optRe);
      if(opt){ options.push(opt[2].trim()); return; }
      if(!question) question=line.replace(/^\s*(س\s*)?\d+[\).\-:\s]*/, '').trim();
      else if(options.length===0) question += ' ' + line;
    });
    if(question && options.length>=2){ questions.push({id:nanoid(8), text:question, options:options.slice(0,4), correctIndex:correctIndexFrom(correct, options), points:Math.max(1,Number(points)||1)}); }
  });
  return questions;
}
function parseQuestionsFromText(text){
  let qs=[];
  try{ qs=parseDelimitedText(text); }catch(e){ qs=[]; }
  if(qs.length) return qs;
  return parseBlocksText(text);
}
async function parseQuestionsFromFile(file){
  const name = String(file.originalname||'').toLowerCase();
  const mime = String(file.mimetype||'').toLowerCase();
  if(name.endsWith('.xlsx') || name.endsWith('.xls')) return parseQuestionsFromExcel(file.buffer);
  if(name.endsWith('.csv') || name.endsWith('.txt') || mime.includes('text')) return parseQuestionsFromText(file.buffer.toString('utf8'));
  if(name.endsWith('.pdf') || mime.includes('pdf')){
    let pdfParse; try { pdfParse = require('pdf-parse'); } catch(e) { throw new Error('مكتبة PDF غير مثبتة. حدّث package.json ثم اعمل Redeploy.'); }
    const data = await pdfParse(file.buffer);
    const text = String(data.text||'').trim();
    if(!text) throw new Error('ملف PDF لا يحتوي على نص قابل للقراءة. لو الملف صور/سكان، حوّله Excel أو PDF نصي.');
    return parseQuestionsFromText(text);
  }
  throw new Error('نوع الملف غير مدعوم. استخدم Excel أو CSV أو TXT أو PDF.');
}
app.get('/', (req,res)=>res.redirect('/admin'));
app.get('/admin/register',(req,res)=>res.send(layout('إنشاء حساب',`<div class="card"><h1>إنشاء حساب مستخدم</h1><p class="muted">سجل بإيميلك، وأي نتيجة لامتحاناتك هتتبعت على نفس الإيميل.</p><form method="post"><label>الإيميل</label><input name="email" type="email" required autofocus placeholder="name@example.com"><label>كلمة السر</label><input name="password" type="password" minlength="6" required><button class="btn">إنشاء حساب</button></form><p>عندك حساب؟ <a href="/admin/login">تسجيل الدخول</a></p></div>`)));
app.post('/admin/register',asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); if(await store.getUserByEmail(email)) return res.send(layout('الحساب موجود',`<div class="error">الإيميل ده مسجل قبل كده.</div><p><a href="/admin/login">سجل دخول</a></p>`)); const user={id:nanoid(10),email,passwordHash:hashPassword(req.body.password),createdAt:new Date().toISOString()}; await store.createUser(user); req.session.userId=user.id; req.session.userEmail=user.email; res.redirect(303, '/admin'); }));
app.get('/admin/login',(req,res)=>res.send(layout('دخول المستخدم',`<div class="card"><h1>تسجيل الدخول</h1><form method="post"><label>الإيميل</label><input name="email" type="email" required autofocus><label>كلمة السر</label><input name="password" type="password" required><button class="btn">دخول</button></form><p>مستخدم جديد؟ <a href="/admin/register">إنشاء حساب</a></p></div>`)));
app.post('/admin/login',asyncRoute(async(req,res)=>{ const user=await store.getUserByEmail(normalizeEmail(req.body.email)); if(user && verifyPassword(req.body.password,user.passwordHash)){ req.session.userId=user.id; req.session.userEmail=user.email; return res.redirect(303, '/admin'); } res.send(layout('خطأ',`<div class="error">الإيميل أو كلمة السر غير صحيحة</div><p><a href="/admin/login">حاول مرة أخرى</a></p>`)); }));
app.get('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect(303, '/admin/login')));
app.get('/admin/account',requireUser,(req,res)=>res.send(layout('حسابي',adminNav(req)+`<div class="card"><h1>حسابي</h1><p>الإيميل الحالي لاستقبال النتائج:</p><h2 class="ltr">${esc(req.user.email)}</h2><form method="post"><label>تغيير الإيميل</label><input name="email" type="email" value="${esc(req.user.email)}" required><button class="btn">حفظ</button></form><p class="notice">أي نتيجة جديدة لامتحاناتك هتتبعت على الإيميل ده، بشرط ضبط إعدادات SMTP على السيرفر.</p></div>`)));
app.post('/admin/account',requireUser,asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); const other=await store.getUserByEmail(email); if(other&&other.id!==req.user.id) return res.send(layout('خطأ',adminNav(req)+`<div class="error">الإيميل مستخدم في حساب آخر.</div>`)); await store.updateUserEmail(req.user.id,email); req.session.userEmail=email; res.redirect(303, '/admin/account'); }));

app.get('/admin',requireUser,asyncRoute(async(req,res)=>{ const base=publicBaseUrl(req); const exams=await store.listExams(req.user.id); const cards=exams.map(e=>{ const link=`${base}/exam/${e.slug}`; return `<div class="card"><h2>${icon('edit')} ${esc(e.title)}</h2><p><span class="badge">${e.questions.length} سؤال</span> <span class="badge">${e.published?'منشور':'غير منشور'}</span></p><div class="linkbox ltr"><a href="/exam/${encodeURIComponent(e.slug)}" target="_blank">${esc(link)}</a></div><div class="row"><button type="button" class="btn ok" onclick="copyLink('${esc(link)}')">${icon('copy')} نسخ رابط الامتحان</button><a class="btn" href="/admin/exams/${e.id}">${icon('edit')} تعديل الأسئلة</a><form method="post" action="/admin/exams/${e.id}/toggle"><button class="btn secondary">${e.published?'إيقاف النشر':icon('rocket')+' نشر'}</button></form><form method="post" action="/admin/exams/${e.id}/delete" onsubmit="return confirm('حذف الامتحان؟')"><button class="btn danger">${icon('trash')} حذف</button></form></div></div>` }).join('')||'<div class="card"><p>لا يوجد امتحانات بعد.</p></div>'; res.send(layout('لوحة التحكم',adminNav(req)+`<h1>لوحة التحكم الاحترافية</h1><div class="card"><h2>${icon('brain')} مساعد التحسين الذكي</h2><div class="ai-panel"><div class="ai-tip">اقترح عنوان واضح للامتحان قبل النشر.</div><div class="ai-tip">راجع الإجابة الصحيحة لكل سؤال قبل نسخ الرابط.</div><div class="ai-tip">بعد النشر، انسخ الرابط وارسله للطلاب مباشرة.</div></div></div><div class="hero"><div class="notice">النتائج محفوظة حتى بعد تسجيل الخروج. ورابط الامتحان يظل شغال للطلاب طالما الامتحان منشور، ولا يتوقف إلا إذا ضغطت إيقاف النشر.</div></div>${cards}`)); }));
app.get('/admin/exams/new',requireUser,(req,res)=>res.send(layout('امتحان جديد',adminNav(req)+`<div class="card"><h1>إنشاء امتحان جديد</h1><form method="post"><label>عنوان الامتحان</label><input name="title" required placeholder="مثال: امتحان مادة العلوم"><label>رابط مختصر اختياري</label><input name="slug" placeholder="science-test"><button class="btn">إنشاء</button></form></div>`)));
app.post('/admin/exams/new',requireUser,asyncRoute(async(req,res)=>{ let slug=slugify(req.body.slug||req.body.title); if(await store.slugExists(slug)) slug+='-'+nanoid(4); const exam={id:nanoid(10),ownerId:req.user.id,title:req.body.title,slug,published:false,questions:[],createdAt:new Date().toISOString()}; await store.createExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
async function getOwnedExam(req,res){ const e=await store.getExamById(req.params.id); if(!e||e.ownerId!==req.user.id){ res.status(404).send('Not found'); return null; } e.questions=e.questions||[]; return e; }
app.get('/admin/exams/:id',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const base=publicBaseUrl(req); const questions=exam.questions.map((q,i)=>`<div class="question"><h3>س${i+1}: ${esc(q.text)} <span class="badge">${q.points} درجة</span></h3><ol>${q.options.map((o,idx)=>`<li>${esc(o)} ${idx==q.correctIndex?'✅':''}</li>`).join('')}</ol><form method="post" action="/admin/exams/${exam.id}/questions/${q.id}/delete"><button class="btn danger">حذف السؤال</button></form></div>`).join('')||'<p class="muted">لا توجد أسئلة بعد.</p>'; res.send(layout('تعديل الامتحان',adminNav(req)+`<div class="card"><h1>${esc(exam.title)}</h1><p>رابط الامتحان:</p><div class="linkbox ltr"><a target="_blank" href="/exam/${encodeURIComponent(exam.slug)}">${base}/exam/${esc(exam.slug)}</a></div><div class="row"><button type="button" class="btn ok" onclick="copyLink('${base}/exam/${esc(exam.slug)}')">${icon('copy')} نسخ رابط الامتحان</button><form method="post" action="/admin/exams/${exam.id}/toggle"><button class="btn ${exam.published?'secondary':'ok'}">${exam.published?'إيقاف النشر':'نشر الامتحان'}</button></form></div></div><div class="card"><h2>إضافة سؤال</h2><form method="post" action="/admin/exams/${exam.id}/questions"><label>نص السؤال</label><textarea name="text" required></textarea><div class="grid"><div><label>اختيار 1</label><input name="opt0" required></div><div><label>اختيار 2</label><input name="opt1" required></div><div><label>اختيار 3</label><input name="opt2"></div><div><label>اختيار 4</label><input name="opt3"></div></div><label>رقم الإجابة الصحيحة</label><select name="correctIndex"><option value="0">اختيار 1</option><option value="1">اختيار 2</option><option value="2">اختيار 3</option><option value="3">اختيار 4</option></select><label>درجة السؤال</label><input name="points" type="number" min="1" value="1" required><button class="btn">${icon('plus')} إضافة السؤال</button></form></div><div class="card"><h2>${icon('save')} استيراد الأسئلة من ملف</h2><p class="notice">ارفع ملف الأسئلة أو CSV أو TXT أو PDF. الأفضل أن تكون الأعمدة: السؤال، اختيار1، اختيار2، اختيار3، اختيار4، الإجابة الصحيحة، الدرجة. وفي PDF/TXT يمكن كتابة السؤال مرقمًا ثم الاختيارات أ/ب/ج/د ثم سطر الإجابة.</p><form method="post" action="/admin/exams/${exam.id}/import-file" enctype="multipart/form-data" onsubmit="this.querySelector('button').textContent='جاري الاستيراد...';this.querySelector('button').disabled=true"><label>ملف الأسئلة</label><input type="file" name="file" accept=".xlsx,.xls,.csv,.txt,.pdf" required><button class="btn ok">${icon('save')} استيراد الأسئلة تلقائيًا</button></form></div><div class="card"><h2>الأسئلة الحالية</h2>${questions}</div>`)); }));
app.post('/admin/exams/:id/import-file',requireUser,upload.single('file'),asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; try{ if(!req.file) return res.send(layout('خطأ',adminNav(req)+`<div class="error">لم يتم اختيار ملف. ارجع واختر ملف الأسئلة.</div>`)); const imported=await parseQuestionsFromFile(req.file); if(imported.length===0) return res.send(layout('لم يتم الاستيراد',adminNav(req)+`<div class="error">لم أجد أسئلة قابلة للقراءة داخل الملف. جرّب Excel بالأعمدة: السؤال، اختيار1، اختيار2، اختيار3، اختيار4، الإجابة الصحيحة، الدرجة.</div><p><a class="btn" href="/admin/exams/${exam.id}">رجوع للامتحان</a></p>`)); exam.questions.push(...imported); await store.updateExam(exam); return res.send(layout('تم الاستيراد',adminNav(req)+`<div class="card"><h1>تم استيراد الأسئلة بنجاح</h1><p class="notice">تم إضافة <b>${imported.length}</b> سؤال إلى الامتحان.</p><p><a class="btn ok" href="/admin/exams/${exam.id}">عرض الأسئلة</a></p></div>`)); }catch(err){ return res.send(layout('خطأ في الاستيراد',adminNav(req)+`<div class="error">${esc(err.message || 'فشل استيراد الملف')}</div><p><a class="btn" href="/admin/exams/${exam.id}">رجوع للامتحان</a></p>`)); } }));
app.post('/admin/exams/:id/questions',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const options=[req.body.opt0,req.body.opt1,req.body.opt2,req.body.opt3].filter(x=>String(x||'').trim()); const correctIndex=Number(req.body.correctIndex); if(options.length<2||correctIndex>=options.length) return res.send(layout('خطأ',adminNav(req)+`<div class="error">لازم على الأقل اختيارين، والإجابة الصحيحة تكون ضمن الاختيارات المكتوبة.</div>`)); exam.questions.push({id:nanoid(8),text:req.body.text,options,correctIndex,points:Number(req.body.points||1)}); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/questions/:qid/delete',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.questions=exam.questions.filter(q=>q.id!==req.params.qid); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/toggle',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.published=!exam.published; await store.updateExam(exam); res.redirect(303, req.get('referer')||'/admin'); }));
app.post('/admin/exams/:id/delete',requireUser,asyncRoute(async(req,res)=>{ await store.deleteExam(req.params.id,req.user.id); res.redirect(303, '/admin'); }));

app.get('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send(layout('غير متاح',`<div class="card"><h1>الامتحان غير متاح</h1><p>الرابط غير صحيح أو الامتحان غير منشور.</p></div>`)); exam.questions=exam.questions||[]; const qs=exam.questions.map((q,i)=>`<div class="card"><h3>س${i+1}: ${esc(q.text)}</h3>${q.options.map((o,idx)=>`<label class="option"><input type="radio" name="q_${q.id}" value="${idx}" required> ${esc(o)}</label>`).join('')}</div>`).join(''); res.send(layout(exam.title,`<h1>${esc(exam.title)}</h1><form method="post"><div class="card"><label>اكتب اسمك</label><input name="studentName" required placeholder="الاسم بالكامل" autofocus></div>${qs}<button class="btn ok">تسليم الامتحان</button></form>`)); }));
app.post('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send('Not found'); const owner=await store.getUserById(exam.ownerId); const ownerEmail=owner?owner.email:null; exam.questions=exam.questions||[]; let score=0,total=0; const answers={}; exam.questions.forEach(q=>{ total+=Number(q.points||1); const ans=Number(req.body[`q_${q.id}`]); answers[q.id]=Number.isFinite(ans)?ans:null; if(ans===q.correctIndex)score+=Number(q.points||1); }); const percent=total?Math.round((score/total)*100):0; const result={id:nanoid(10),examId:exam.id,ownerId:exam.ownerId,ownerEmail,examTitle:exam.title,studentName:req.body.studentName,score,total,percent,answers,createdAt:new Date().toISOString()}; await store.addResult(result); notifyResult(result).catch(err=>console.error('email error',err.message)); res.send(layout('النتيجة',`<div class="card"><h1>تم تسليم الامتحان</h1><p>الاسم: <b>${esc(result.studentName)}</b></p><h2>درجتك: ${score} من ${total}</h2><h2>النسبة: ${percent}%</h2><p class="muted">تم تسجيل النتيجة، وسيتم إرسالها لصاحب الامتحان على إيميله إذا كان إرسال الإيميل متفعلًا.</p></div>`)); }));
app.get('/admin/results',requireUser,asyncRoute(async(req,res)=>{ const results=await store.listResults(req.user.id); const rows=results.map(r=>`<tr><td>${esc(r.studentName)}</td><td>${esc(r.examTitle)}</td><td>${r.score}/${r.total}</td><td>${r.percent}%</td><td>${new Date(r.createdAt).toLocaleString('ar-EG')}</td><td><form method="post" action="/admin/results/${r.id}/delete" onsubmit="return confirm('حذف هذه النتيجة؟')"><button class="btn danger">${icon('trash')} حذف</button></form></td></tr>`).join('')||'<tr><td colspan="6">لا توجد نتائج بعد</td></tr>'; res.send(layout('النتائج',adminNav(req)+`<div class="card"><h1>نتائج الطلاب</h1><p class="notice">النتائج تفضل محفوظة حتى لو خرجت من الحساب، ولا تُحذف إلا من زر الحذف.</p><div class="row"><a class="btn secondary" href="/admin/results.csv">تحميل CSV</a><form method="post" action="/admin/results/delete-all" onsubmit="return confirm('حذف كل النتائج؟')"><button class="btn danger">${icon('trash')} حذف كل النتائج</button></form></div><table class="table"><thead><tr><th>الاسم</th><th>الامتحان</th><th>الدرجة</th><th>النسبة</th><th>الوقت</th><th>إجراء</th></tr></thead><tbody>${rows}</tbody></table></div>`)); }));
app.post('/admin/results/:id/delete',requireUser,asyncRoute(async(req,res)=>{ await store.deleteResult(req.params.id, req.user.id); res.redirect(303, '/admin/results'); }));
app.post('/admin/results/delete-all',requireUser,asyncRoute(async(req,res)=>{ await store.deleteAllResults(req.user.id); res.redirect(303, '/admin/results'); }));
app.get('/admin/results.csv',requireUser,asyncRoute(async(req,res)=>{ const results=await store.listResults(req.user.id); const header='studentName,examTitle,score,total,percent,createdAt\n'; const lines=results.map(r=>[r.studentName,r.examTitle,r.score,r.total,r.percent,r.createdAt].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'); res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="results.csv"'); res.send('\ufeff'+header+lines); }));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).send(layout('خطأ',`<div class="error">حصل خطأ في السيرفر. راجع Logs.</div>`)); });


let initPromise = initDb();

if (require.main === module) {
  initPromise
    .then(() => app.listen(PORT, () => console.log(`Exam app running on ${BASE_URL} - DB: ${HAS_POSTGRES ? 'Postgres' : 'JSON file'}`)))
    .catch(err => { console.error('DB init failed', err); process.exit(1); });
} else {
  module.exports = async (req, res) => {
    try {
      await initPromise;
      return app(req, res);
    } catch (err) {
      console.error('DB init failed', err);
      res.statusCode = 500;
      res.end('DB init failed');
    }
  };
}

