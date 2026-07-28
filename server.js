const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { nanoid } = require('nanoid');
const { Pool } = require('pg');

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
function encodeNonAscii(html=''){ return String(html).replace(/[\u0080-\uFFFF]/g, ch => '&#' + ch.charCodeAt(0) + ';'); }
function layout(title, body){
  const css = `:root{--bg1:#0f172a;--bg2:#1e1b4b;--card:#ffffffee;--text:#111827;--muted:#64748b;--primary:#7c3aed;--primary2:#06b6d4;--danger:#ef4444;--border:#e5e7eb;--ok:#22c55e;--shadow:0 18px 45px #0206172b}*{box-sizing:border-box}html{min-height:100%}body{margin:0;font-family:Tahoma,Arial,sans-serif;color:var(--text);direction:rtl;min-height:100vh;background:linear-gradient(135deg,var(--bg1),var(--bg2));overflow-x:hidden}body:before,body:after{content:"";position:fixed;width:420px;height:420px;border-radius:999px;filter:blur(45px);opacity:.35;z-index:-1;animation:floaty 11s ease-in-out infinite}body:before{background:#22d3ee;top:-120px;right:-120px}body:after{background:#a855f7;bottom:-140px;left:-120px;animation-delay:-4s}@keyframes floaty{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(45px,35px) scale(1.15)}}.container{max-width:1050px;margin:auto;padding:24px}.card{background:var(--card);backdrop-filter:blur(14px);border:1px solid #ffffff80;border-radius:22px;padding:22px;margin:18px 0;box-shadow:var(--shadow);animation:rise .45s ease both}@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}h1{font-size:34px;background:linear-gradient(90deg,#fff,#bae6fd);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 10px 25px #0004;margin:10px 0 22px}h2,h3{margin-top:0}.card h1,.card h2,.card h3{color:#111827;background:none;-webkit-text-fill-color:initial;text-shadow:none}.muted{color:var(--muted)}a{color:#2563eb;text-decoration:none;font-weight:700}.nav{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;background:#ffffff22;border:1px solid #ffffff40;border-radius:20px;padding:10px;backdrop-filter:blur(12px)}.nav a,.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:linear-gradient(135deg,var(--primary),var(--primary2));color:white;border:none;border-radius:14px;padding:11px 15px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 10px 25px #0002;transition:.2s}.nav a:hover,.btn:hover{transform:translateY(-2px);filter:saturate(1.15)}.btn.secondary{background:linear-gradient(135deg,#334155,#64748b)}.btn.danger{background:linear-gradient(135deg,#dc2626,#fb7185)}.btn.ok{background:linear-gradient(135deg,#16a34a,#22c55e)}input,textarea,select{width:100%;padding:13px;border:1px solid var(--border);border-radius:14px;margin:7px 0 15px;font-size:15px;background:#fff;outline:none;transition:.2s}input:focus,textarea:focus,select:focus{border-color:#7c3aed;box-shadow:0 0 0 4px #7c3aed22}label{font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.option{display:flex;gap:8px;align-items:center;padding:10px;border:1px solid #e5e7eb;border-radius:14px;margin:8px 0;background:#f8fafc}.option input[type=radio]{width:auto;margin:0}.table{width:100%;border-collapse:separate;border-spacing:0 8px;overflow:auto}.table th{color:#475569}.table th,.table td{padding:12px;text-align:right}.table tr{background:#f8fafc}.table td:first-child,.table th:first-child{border-radius:0 14px 14px 0}.table td:last-child,.table th:last-child{border-radius:14px 0 0 14px}.badge{background:#ede9fe;color:#6d28d9;border-radius:999px;padding:5px 11px;font-size:13px;font-weight:800}.notice{padding:12px;border-radius:14px;background:#ecfeff;border:1px solid #a5f3fc}.error{padding:12px;border-radius:14px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b}.ltr{direction:ltr;text-align:left}.small{font-size:13px}.question{border-top:1px solid var(--border);padding-top:16px;margin-top:16px}.linkbox{background:#eef2ff;border:1px dashed #818cf8;border-radius:16px;padding:12px;word-break:break-all}.hero{display:grid;grid-template-columns:1fr;gap:8px}.footer{margin:28px 0 8px;text-align:center;color:#e0e7ff;font-size:14px}.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#111827;color:#fff;padding:12px 18px;border-radius:999px;box-shadow:var(--shadow);z-index:50;display:none}@media(max-width:600px){.container{padding:12px}.card{padding:15px;border-radius:18px}h1{font-size:28px}.nav a,.btn{width:100%;text-align:center}.row form{width:100%}}`;
  const js = `<script>var audioCtx;function beep(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();var o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=650;g.gain.setValueAtTime(.045,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.09);o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+.1)}catch(e){}}document.addEventListener('click',function(e){if(e.target.closest('button,.btn,a'))beep()});function copyLink(t){beep();navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){toast('تم نسخ رابط الامتحان')}).catch(function(){prompt('انسخ الرابط',t)})}function toast(t){var e=document.getElementById('toast');if(!e)return;e.textContent=t;e.style.display='block';setTimeout(function(){e.style.display='none'},1800)}</script>`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main class="container">${body}<footer class="footer">تم التطوير بواسطة ahmed</footer></main><div id="toast" class="toast"></div>${js}</body></html>`;
  return encodeNonAscii(html);
}
function adminNav(req){ return `<div class="nav"><a href="/admin">الرئيسية</a><a href="/admin/exams/new">امتحان جديد</a><a href="/admin/results">النتائج</a><a href="/admin/account">حسابي</a><a class="btn secondary" href="/admin/logout">خروج</a></div><p class="muted small">مسجل دخول: ${esc(req.session.userEmail || '')}</p>`; }
async function requireUser(req,res,next){ const u = req.session.userId ? await store.getUserById(req.session.userId) : null; if(u){ req.user=u; return next(); } res.redirect(303, '/admin/login'); }
function slugify(s){ return String(s||'exam').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-\u0600-\u06FF]/g,'').slice(0,60) || nanoid(6); }
function normalizeEmail(email){ return String(email || '').trim().toLowerCase(); }
function publicBaseUrl(req){ const proto=String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0]; return `${proto}://${req.headers.host}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){ const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex'); return `${salt}:${hash}`; }
function verifyPassword(password, stored){ if(!stored || !stored.includes(':')) return false; const [salt, oldHash] = stored.split(':'); const newHash = hashPassword(password, salt).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(oldHash), Buffer.from(newHash)); }
function getMailer(){ if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null; return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }); }
async function notifyResult({ examTitle, studentName, score, total, percent, ownerEmail }){ const mailer=getMailer(); if(!mailer||!ownerEmail) return; await mailer.sendMail({ from:process.env.MAIL_FROM||process.env.SMTP_USER, to:ownerEmail, subject:`نتيجة جديدة: ${studentName} - ${examTitle}`, text:`الاسم: ${studentName}\nالامتحان: ${examTitle}\nالدرجة: ${score}/${total}\nالنسبة: ${percent}%\nالوقت: ${new Date().toLocaleString('ar-EG')}\n\nتم التطوير بواسطة ahmed` }); }

app.get('/', (req,res)=>res.redirect('/admin'));
app.get('/admin/register',(req,res)=>res.send(layout('إنشاء حساب',`<div class="card"><h1>إنشاء حساب مستخدم</h1><p class="muted">سجل بإيميلك، وأي نتيجة لامتحاناتك هتتبعت على نفس الإيميل.</p><form method="post"><label>الإيميل</label><input name="email" type="email" required autofocus placeholder="name@example.com"><label>كلمة السر</label><input name="password" type="password" minlength="6" required><button class="btn">إنشاء حساب</button></form><p>عندك حساب؟ <a href="/admin/login">تسجيل الدخول</a></p></div>`)));
app.post('/admin/register',asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); if(await store.getUserByEmail(email)) return res.send(layout('الحساب موجود',`<div class="error">الإيميل ده مسجل قبل كده.</div><p><a href="/admin/login">سجل دخول</a></p>`)); const user={id:nanoid(10),email,passwordHash:hashPassword(req.body.password),createdAt:new Date().toISOString()}; await store.createUser(user); req.session.userId=user.id; req.session.userEmail=user.email; res.redirect(303, '/admin'); }));
app.get('/admin/login',(req,res)=>res.send(layout('دخول المستخدم',`<div class="card"><h1>تسجيل الدخول</h1><form method="post"><label>الإيميل</label><input name="email" type="email" required autofocus><label>كلمة السر</label><input name="password" type="password" required><button class="btn">دخول</button></form><p>مستخدم جديد؟ <a href="/admin/register">إنشاء حساب</a></p></div>`)));
app.post('/admin/login',asyncRoute(async(req,res)=>{ const user=await store.getUserByEmail(normalizeEmail(req.body.email)); if(user && verifyPassword(req.body.password,user.passwordHash)){ req.session.userId=user.id; req.session.userEmail=user.email; return res.redirect(303, '/admin'); } res.send(layout('خطأ',`<div class="error">الإيميل أو كلمة السر غير صحيحة</div><p><a href="/admin/login">حاول مرة أخرى</a></p>`)); }));
app.get('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect(303, '/admin/login')));
app.get('/admin/account',requireUser,(req,res)=>res.send(layout('حسابي',adminNav(req)+`<div class="card"><h1>حسابي</h1><p>الإيميل الحالي لاستقبال النتائج:</p><h2 class="ltr">${esc(req.user.email)}</h2><form method="post"><label>تغيير الإيميل</label><input name="email" type="email" value="${esc(req.user.email)}" required><button class="btn">حفظ</button></form><p class="notice">أي نتيجة جديدة لامتحاناتك هتتبعت على الإيميل ده، بشرط ضبط إعدادات SMTP على السيرفر.</p></div>`)));
app.post('/admin/account',requireUser,asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); const other=await store.getUserByEmail(email); if(other&&other.id!==req.user.id) return res.send(layout('خطأ',adminNav(req)+`<div class="error">الإيميل مستخدم في حساب آخر.</div>`)); await store.updateUserEmail(req.user.id,email); req.session.userEmail=email; res.redirect(303, '/admin/account'); }));

app.get('/admin',requireUser,asyncRoute(async(req,res)=>{ const base=publicBaseUrl(req); const exams=await store.listExams(req.user.id); const cards=exams.map(e=>{ const link=`${base}/exam/${e.slug}`; return `<div class="card"><h2>📝 ${esc(e.title)}</h2><p><span class="badge">${e.questions.length} سؤال</span> <span class="badge">${e.published?'منشور':'غير منشور'}</span></p><div class="linkbox ltr"><a href="/exam/${encodeURIComponent(e.slug)}" target="_blank">${esc(link)}</a></div><div class="row"><button type="button" class="btn ok" onclick="copyLink('${esc(link)}')">📋 نسخ رابط الامتحان</button><a class="btn" href="/admin/exams/${e.id}">⚙️ تعديل الأسئلة</a><form method="post" action="/admin/exams/${e.id}/toggle"><button class="btn secondary">${e.published?'⏸️ إيقاف النشر':'🚀 نشر'}</button></form><form method="post" action="/admin/exams/${e.id}/delete" onsubmit="return confirm('حذف الامتحان؟')"><button class="btn danger">🗑️ حذف</button></form></div></div>` }).join('')||'<div class="card"><p>لا يوجد امتحانات بعد.</p></div>'; res.send(layout('لوحة التحكم',adminNav(req)+`<h1>✨ لوحة التحكم الاحترافية</h1><div class="hero"><div class="notice">النتائج محفوظة حتى بعد تسجيل الخروج. ورابط الامتحان يظل شغال للطلاب طالما الامتحان منشور، ولا يتوقف إلا إذا ضغطت إيقاف النشر.</div></div>${cards}`)); }));
app.get('/admin/exams/new',requireUser,(req,res)=>res.send(layout('امتحان جديد',adminNav(req)+`<div class="card"><h1>إنشاء امتحان جديد</h1><form method="post"><label>عنوان الامتحان</label><input name="title" required placeholder="مثال: امتحان مادة العلوم"><label>رابط مختصر اختياري</label><input name="slug" placeholder="science-test"><button class="btn">إنشاء</button></form></div>`)));
app.post('/admin/exams/new',requireUser,asyncRoute(async(req,res)=>{ let slug=slugify(req.body.slug||req.body.title); if(await store.slugExists(slug)) slug+='-'+nanoid(4); const exam={id:nanoid(10),ownerId:req.user.id,title:req.body.title,slug,published:false,questions:[],createdAt:new Date().toISOString()}; await store.createExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
async function getOwnedExam(req,res){ const e=await store.getExamById(req.params.id); if(!e||e.ownerId!==req.user.id){ res.status(404).send('Not found'); return null; } e.questions=e.questions||[]; return e; }
app.get('/admin/exams/:id',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const base=publicBaseUrl(req); const questions=exam.questions.map((q,i)=>`<div class="question"><h3>س${i+1}: ${esc(q.text)} <span class="badge">${q.points} درجة</span></h3><ol>${q.options.map((o,idx)=>`<li>${esc(o)} ${idx==q.correctIndex?'✅':''}</li>`).join('')}</ol><form method="post" action="/admin/exams/${exam.id}/questions/${q.id}/delete"><button class="btn danger">حذف السؤال</button></form></div>`).join('')||'<p class="muted">لا توجد أسئلة بعد.</p>'; res.send(layout('تعديل الامتحان',adminNav(req)+`<div class="card"><h1>${esc(exam.title)}</h1><p>رابط الامتحان:</p><div class="linkbox ltr"><a target="_blank" href="/exam/${encodeURIComponent(exam.slug)}">${base}/exam/${esc(exam.slug)}</a></div><div class="row"><button type="button" class="btn ok" onclick="copyLink('${base}/exam/${esc(exam.slug)}')">📋 نسخ رابط الامتحان</button><form method="post" action="/admin/exams/${exam.id}/toggle"><button class="btn ${exam.published?'secondary':'ok'}">${exam.published?'إيقاف النشر':'نشر الامتحان'}</button></form></div></div><div class="card"><h2>إضافة سؤال</h2><form method="post" action="/admin/exams/${exam.id}/questions"><label>نص السؤال</label><textarea name="text" required></textarea><div class="grid"><div><label>اختيار 1</label><input name="opt0" required></div><div><label>اختيار 2</label><input name="opt1" required></div><div><label>اختيار 3</label><input name="opt2"></div><div><label>اختيار 4</label><input name="opt3"></div></div><label>رقم الإجابة الصحيحة</label><select name="correctIndex"><option value="0">اختيار 1</option><option value="1">اختيار 2</option><option value="2">اختيار 3</option><option value="3">اختيار 4</option></select><label>درجة السؤال</label><input name="points" type="number" min="1" value="1" required><button class="btn">إضافة السؤال</button></form></div><div class="card"><h2>الأسئلة الحالية</h2>${questions}</div>`)); }));
app.post('/admin/exams/:id/questions',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const options=[req.body.opt0,req.body.opt1,req.body.opt2,req.body.opt3].filter(x=>String(x||'').trim()); const correctIndex=Number(req.body.correctIndex); if(options.length<2||correctIndex>=options.length) return res.send(layout('خطأ',adminNav(req)+`<div class="error">لازم على الأقل اختيارين، والإجابة الصحيحة تكون ضمن الاختيارات المكتوبة.</div>`)); exam.questions.push({id:nanoid(8),text:req.body.text,options,correctIndex,points:Number(req.body.points||1)}); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/questions/:qid/delete',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.questions=exam.questions.filter(q=>q.id!==req.params.qid); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/toggle',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.published=!exam.published; await store.updateExam(exam); res.redirect(303, req.get('referer')||'/admin'); }));
app.post('/admin/exams/:id/delete',requireUser,asyncRoute(async(req,res)=>{ await store.deleteExam(req.params.id,req.user.id); res.redirect(303, '/admin'); }));

app.get('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send(layout('غير متاح',`<div class="card"><h1>الامتحان غير متاح</h1><p>الرابط غير صحيح أو الامتحان غير منشور.</p></div>`)); exam.questions=exam.questions||[]; const qs=exam.questions.map((q,i)=>`<div class="card"><h3>س${i+1}: ${esc(q.text)}</h3>${q.options.map((o,idx)=>`<label class="option"><input type="radio" name="q_${q.id}" value="${idx}" required> ${esc(o)}</label>`).join('')}</div>`).join(''); res.send(layout(exam.title,`<h1>${esc(exam.title)}</h1><form method="post"><div class="card"><label>اكتب اسمك</label><input name="studentName" required placeholder="الاسم بالكامل" autofocus></div>${qs}<button class="btn ok">تسليم الامتحان</button></form>`)); }));
app.post('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send('Not found'); const owner=await store.getUserById(exam.ownerId); const ownerEmail=owner?owner.email:null; exam.questions=exam.questions||[]; let score=0,total=0; const answers={}; exam.questions.forEach(q=>{ total+=Number(q.points||1); const ans=Number(req.body[`q_${q.id}`]); answers[q.id]=Number.isFinite(ans)?ans:null; if(ans===q.correctIndex)score+=Number(q.points||1); }); const percent=total?Math.round((score/total)*100):0; const result={id:nanoid(10),examId:exam.id,ownerId:exam.ownerId,ownerEmail,examTitle:exam.title,studentName:req.body.studentName,score,total,percent,answers,createdAt:new Date().toISOString()}; await store.addResult(result); notifyResult(result).catch(err=>console.error('email error',err.message)); res.send(layout('النتيجة',`<div class="card"><h1>تم تسليم الامتحان</h1><p>الاسم: <b>${esc(result.studentName)}</b></p><h2>درجتك: ${score} من ${total}</h2><h2>النسبة: ${percent}%</h2><p class="muted">تم تسجيل النتيجة، وسيتم إرسالها لصاحب الامتحان على إيميله إذا كان إرسال الإيميل متفعلًا.</p></div>`)); }));
app.get('/admin/results',requireUser,asyncRoute(async(req,res)=>{ const results=await store.listResults(req.user.id); const rows=results.map(r=>`<tr><td>${esc(r.studentName)}</td><td>${esc(r.examTitle)}</td><td>${r.score}/${r.total}</td><td>${r.percent}%</td><td>${new Date(r.createdAt).toLocaleString('ar-EG')}</td><td><form method="post" action="/admin/results/${r.id}/delete" onsubmit="return confirm('حذف هذه النتيجة؟')"><button class="btn danger">🗑️ حذف</button></form></td></tr>`).join('')||'<tr><td colspan="6">لا توجد نتائج بعد</td></tr>'; res.send(layout('النتائج',adminNav(req)+`<div class="card"><h1>📊 نتائج الطلاب</h1><p class="notice">النتائج تفضل محفوظة حتى لو خرجت من الحساب، ولا تُحذف إلا من زر الحذف.</p><div class="row"><a class="btn secondary" href="/admin/results.csv">⬇️ تحميل CSV</a><form method="post" action="/admin/results/delete-all" onsubmit="return confirm('حذف كل النتائج؟')"><button class="btn danger">🗑️ حذف كل النتائج</button></form></div><table class="table"><thead><tr><th>الاسم</th><th>الامتحان</th><th>الدرجة</th><th>النسبة</th><th>الوقت</th><th>إجراء</th></tr></thead><tbody>${rows}</tbody></table></div>`)); }));
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

