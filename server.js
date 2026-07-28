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
  }
};

function asyncRoute(fn){ return (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next); }
function esc(s=''){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function layout(title, body){ return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main class="container">${body}<footer class="footer">طھظ… ط§ظ„طھط·ظˆظٹط± ط¨ظˆط§ط³ط·ط© ahmed</footer></main></body></html>`; }
function adminNav(req){ return `<div class="nav"><a href="/admin">ط§ظ„ط±ط¦ظٹط³ظٹط©</a><a href="/admin/exams/new">ط§ظ…طھط­ط§ظ† ط¬ط¯ظٹط¯</a><a href="/admin/results">ط§ظ„ظ†طھط§ط¦ط¬</a><a href="/admin/account">ط­ط³ط§ط¨ظٹ</a><a class="btn secondary" href="/admin/logout">ط®ط±ظˆط¬</a></div><p class="muted small">ظ…ط³ط¬ظ„ ط¯ط®ظˆظ„: ${esc(req.session.userEmail || '')}</p>`; }
async function requireUser(req,res,next){ const u = req.session.userId ? await store.getUserById(req.session.userId) : null; if(u){ req.user=u; return next(); } res.redirect(303, '/admin/login'); }
function slugify(s){ return String(s||'exam').trim().toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-\u0600-\u06FF]/g,'').slice(0,60) || nanoid(6); }
function normalizeEmail(email){ return String(email || '').trim().toLowerCase(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){ const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex'); return `${salt}:${hash}`; }
function verifyPassword(password, stored){ if(!stored || !stored.includes(':')) return false; const [salt, oldHash] = stored.split(':'); const newHash = hashPassword(password, salt).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(oldHash), Buffer.from(newHash)); }
function getMailer(){ if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null; return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_SECURE || 'false') === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }); }
async function notifyResult({ examTitle, studentName, score, total, percent, ownerEmail }){ const mailer=getMailer(); if(!mailer||!ownerEmail) return; await mailer.sendMail({ from:process.env.MAIL_FROM||process.env.SMTP_USER, to:ownerEmail, subject:`ظ†طھظٹط¬ط© ط¬ط¯ظٹط¯ط©: ${studentName} - ${examTitle}`, text:`ط§ظ„ط§ط³ظ…: ${studentName}\nط§ظ„ط§ظ…طھط­ط§ظ†: ${examTitle}\nط§ظ„ط¯ط±ط¬ط©: ${score}/${total}\nط§ظ„ظ†ط³ط¨ط©: ${percent}%\nط§ظ„ظˆظ‚طھ: ${new Date().toLocaleString('ar-EG')}\n\nطھظ… ط§ظ„طھط·ظˆظٹط± ط¨ظˆط§ط³ط·ط© ahmed` }); }

app.get('/', (req,res)=>res.redirect('/admin'));
app.get('/admin/register',(req,res)=>res.send(layout('ط¥ظ†ط´ط§ط، ط­ط³ط§ط¨',`<div class="card"><h1>ط¥ظ†ط´ط§ط، ط­ط³ط§ط¨ ظ…ط³طھط®ط¯ظ…</h1><p class="muted">ط³ط¬ظ„ ط¨ط¥ظٹظ…ظٹظ„ظƒطŒ ظˆط£ظٹ ظ†طھظٹط¬ط© ظ„ط§ظ…طھط­ط§ظ†ط§طھظƒ ظ‡طھطھط¨ط¹طھ ط¹ظ„ظ‰ ظ†ظپط³ ط§ظ„ط¥ظٹظ…ظٹظ„.</p><form method="post"><label>ط§ظ„ط¥ظٹظ…ظٹظ„</label><input name="email" type="email" required autofocus placeholder="name@example.com"><label>ظƒظ„ظ…ط© ط§ظ„ط³ط±</label><input name="password" type="password" minlength="6" required><button class="btn">ط¥ظ†ط´ط§ط، ط­ط³ط§ط¨</button></form><p>ط¹ظ†ط¯ظƒ ط­ط³ط§ط¨طں <a href="/admin/login">طھط³ط¬ظٹظ„ ط§ظ„ط¯ط®ظˆظ„</a></p></div>`)));
app.post('/admin/register',asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); if(await store.getUserByEmail(email)) return res.send(layout('ط§ظ„ط­ط³ط§ط¨ ظ…ظˆط¬ظˆط¯',`<div class="error">ط§ظ„ط¥ظٹظ…ظٹظ„ ط¯ظ‡ ظ…ط³ط¬ظ„ ظ‚ط¨ظ„ ظƒط¯ظ‡.</div><p><a href="/admin/login">ط³ط¬ظ„ ط¯ط®ظˆظ„</a></p>`)); const user={id:nanoid(10),email,passwordHash:hashPassword(req.body.password),createdAt:new Date().toISOString()}; await store.createUser(user); req.session.userId=user.id; req.session.userEmail=user.email; res.redirect(303, '/admin'); }));
app.get('/admin/login',(req,res)=>res.send(layout('ط¯ط®ظˆظ„ ط§ظ„ظ…ط³طھط®ط¯ظ…',`<div class="card"><h1>طھط³ط¬ظٹظ„ ط§ظ„ط¯ط®ظˆظ„</h1><form method="post"><label>ط§ظ„ط¥ظٹظ…ظٹظ„</label><input name="email" type="email" required autofocus><label>ظƒظ„ظ…ط© ط§ظ„ط³ط±</label><input name="password" type="password" required><button class="btn">ط¯ط®ظˆظ„</button></form><p>ظ…ط³طھط®ط¯ظ… ط¬ط¯ظٹط¯طں <a href="/admin/register">ط¥ظ†ط´ط§ط، ط­ط³ط§ط¨</a></p></div>`)));
app.post('/admin/login',asyncRoute(async(req,res)=>{ const user=await store.getUserByEmail(normalizeEmail(req.body.email)); if(user && verifyPassword(req.body.password,user.passwordHash)){ req.session.userId=user.id; req.session.userEmail=user.email; return res.redirect(303, '/admin'); } res.send(layout('ط®ط·ط£',`<div class="error">ط§ظ„ط¥ظٹظ…ظٹظ„ ط£ظˆ ظƒظ„ظ…ط© ط§ظ„ط³ط± ط؛ظٹط± طµط­ظٹط­ط©</div><p><a href="/admin/login">ط­ط§ظˆظ„ ظ…ط±ط© ط£ط®ط±ظ‰</a></p>`)); }));
app.get('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect(303, '/admin/login')));
app.get('/admin/account',requireUser,(req,res)=>res.send(layout('ط­ط³ط§ط¨ظٹ',adminNav(req)+`<div class="card"><h1>ط­ط³ط§ط¨ظٹ</h1><p>ط§ظ„ط¥ظٹظ…ظٹظ„ ط§ظ„ط­ط§ظ„ظٹ ظ„ط§ط³طھظ‚ط¨ط§ظ„ ط§ظ„ظ†طھط§ط¦ط¬:</p><h2 class="ltr">${esc(req.user.email)}</h2><form method="post"><label>طھط؛ظٹظٹط± ط§ظ„ط¥ظٹظ…ظٹظ„</label><input name="email" type="email" value="${esc(req.user.email)}" required><button class="btn">ط­ظپط¸</button></form><p class="notice">ط£ظٹ ظ†طھظٹط¬ط© ط¬ط¯ظٹط¯ط© ظ„ط§ظ…طھط­ط§ظ†ط§طھظƒ ظ‡طھطھط¨ط¹طھ ط¹ظ„ظ‰ ط§ظ„ط¥ظٹظ…ظٹظ„ ط¯ظ‡طŒ ط¨ط´ط±ط· ط¶ط¨ط· ط¥ط¹ط¯ط§ط¯ط§طھ SMTP ط¹ظ„ظ‰ ط§ظ„ط³ظٹط±ظپط±.</p></div>`)));
app.post('/admin/account',requireUser,asyncRoute(async(req,res)=>{ const email=normalizeEmail(req.body.email); const other=await store.getUserByEmail(email); if(other&&other.id!==req.user.id) return res.send(layout('ط®ط·ط£',adminNav(req)+`<div class="error">ط§ظ„ط¥ظٹظ…ظٹظ„ ظ…ط³طھط®ط¯ظ… ظپظٹ ط­ط³ط§ط¨ ط¢ط®ط±.</div>`)); await store.updateUserEmail(req.user.id,email); req.session.userEmail=email; res.redirect(303, '/admin/account'); }));

app.get('/admin',requireUser,asyncRoute(async(req,res)=>{ const exams=await store.listExams(req.user.id); const cards=exams.map(e=>`<div class="card"><h2>${esc(e.title)}</h2><p><span class="badge">${e.questions.length} ط³ط¤ط§ظ„</span> <span class="badge">${e.published?'ظ…ظ†ط´ظˆط±':'ط؛ظٹط± ظ…ظ†ط´ظˆط±'}</span></p><p class="ltr"><a href="/exam/${encodeURIComponent(e.slug)}" target="_blank">${BASE_URL}/exam/${esc(e.slug)}</a></p><div class="row"><a class="btn" href="/admin/exams/${e.id}">طھط¹ط¯ظٹظ„ ط§ظ„ط£ط³ط¦ظ„ط©</a><form method="post" action="/admin/exams/${e.id}/toggle"><button class="btn secondary">${e.published?'ط¥ظٹظ‚ط§ظپ ط§ظ„ظ†ط´ط±':'ظ†ط´ط±'}</button></form><form method="post" action="/admin/exams/${e.id}/delete" onsubmit="return confirm('ط­ط°ظپ ط§ظ„ط§ظ…طھط­ط§ظ†طں')"><button class="btn danger">ط­ط°ظپ</button></form></div></div>`).join('')||'<div class="card"><p>ظ„ط§ ظٹظˆط¬ط¯ ط§ظ…طھط­ط§ظ†ط§طھ ط¨ط¹ط¯.</p></div>'; res.send(layout('ظ„ظˆط­ط© ط§ظ„طھط­ظƒظ…',adminNav(req)+`<h1>ظ„ظˆط­ط© ط§ظ„طھط­ظƒظ…</h1>${cards}`)); }));
app.get('/admin/exams/new',requireUser,(req,res)=>res.send(layout('ط§ظ…طھط­ط§ظ† ط¬ط¯ظٹط¯',adminNav(req)+`<div class="card"><h1>ط¥ظ†ط´ط§ط، ط§ظ…طھط­ط§ظ† ط¬ط¯ظٹط¯</h1><form method="post"><label>ط¹ظ†ظˆط§ظ† ط§ظ„ط§ظ…طھط­ط§ظ†</label><input name="title" required placeholder="ظ…ط«ط§ظ„: ط§ظ…طھط­ط§ظ† ظ…ط§ط¯ط© ط§ظ„ط¹ظ„ظˆظ…"><label>ط±ط§ط¨ط· ظ…ط®طھطµط± ط§ط®طھظٹط§ط±ظٹ</label><input name="slug" placeholder="science-test"><button class="btn">ط¥ظ†ط´ط§ط،</button></form></div>`)));
app.post('/admin/exams/new',requireUser,asyncRoute(async(req,res)=>{ let slug=slugify(req.body.slug||req.body.title); if(await store.slugExists(slug)) slug+='-'+nanoid(4); const exam={id:nanoid(10),ownerId:req.user.id,title:req.body.title,slug,published:false,questions:[],createdAt:new Date().toISOString()}; await store.createExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
async function getOwnedExam(req,res){ const e=await store.getExamById(req.params.id); if(!e||e.ownerId!==req.user.id){ res.status(404).send('Not found'); return null; } e.questions=e.questions||[]; return e; }
app.get('/admin/exams/:id',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const questions=exam.questions.map((q,i)=>`<div class="question"><h3>ط³${i+1}: ${esc(q.text)} <span class="badge">${q.points} ط¯ط±ط¬ط©</span></h3><ol>${q.options.map((o,idx)=>`<li>${esc(o)} ${idx==q.correctIndex?'âœ…':''}</li>`).join('')}</ol><form method="post" action="/admin/exams/${exam.id}/questions/${q.id}/delete"><button class="btn danger">ط­ط°ظپ ط§ظ„ط³ط¤ط§ظ„</button></form></div>`).join('')||'<p class="muted">ظ„ط§ طھظˆط¬ط¯ ط£ط³ط¦ظ„ط© ط¨ط¹ط¯.</p>'; res.send(layout('طھط¹ط¯ظٹظ„ ط§ظ„ط§ظ…طھط­ط§ظ†',adminNav(req)+`<div class="card"><h1>${esc(exam.title)}</h1><p>ط±ط§ط¨ط· ط§ظ„ط§ظ…طھط­ط§ظ†:</p><p class="ltr"><a target="_blank" href="/exam/${encodeURIComponent(exam.slug)}">${BASE_URL}/exam/${esc(exam.slug)}</a></p><form method="post" action="/admin/exams/${exam.id}/toggle"><button class="btn ${exam.published?'secondary':'ok'}">${exam.published?'ط¥ظٹظ‚ط§ظپ ط§ظ„ظ†ط´ط±':'ظ†ط´ط± ط§ظ„ط§ظ…طھط­ط§ظ†'}</button></form></div><div class="card"><h2>ط¥ط¶ط§ظپط© ط³ط¤ط§ظ„</h2><form method="post" action="/admin/exams/${exam.id}/questions"><label>ظ†طµ ط§ظ„ط³ط¤ط§ظ„</label><textarea name="text" required></textarea><div class="grid"><div><label>ط§ط®طھظٹط§ط± 1</label><input name="opt0" required></div><div><label>ط§ط®طھظٹط§ط± 2</label><input name="opt1" required></div><div><label>ط§ط®طھظٹط§ط± 3</label><input name="opt2"></div><div><label>ط§ط®طھظٹط§ط± 4</label><input name="opt3"></div></div><label>ط±ظ‚ظ… ط§ظ„ط¥ط¬ط§ط¨ط© ط§ظ„طµط­ظٹط­ط©</label><select name="correctIndex"><option value="0">ط§ط®طھظٹط§ط± 1</option><option value="1">ط§ط®طھظٹط§ط± 2</option><option value="2">ط§ط®طھظٹط§ط± 3</option><option value="3">ط§ط®طھظٹط§ط± 4</option></select><label>ط¯ط±ط¬ط© ط§ظ„ط³ط¤ط§ظ„</label><input name="points" type="number" min="1" value="1" required><button class="btn">ط¥ط¶ط§ظپط© ط§ظ„ط³ط¤ط§ظ„</button></form></div><div class="card"><h2>ط§ظ„ط£ط³ط¦ظ„ط© ط§ظ„ط­ط§ظ„ظٹط©</h2>${questions}</div>`)); }));
app.post('/admin/exams/:id/questions',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; const options=[req.body.opt0,req.body.opt1,req.body.opt2,req.body.opt3].filter(x=>String(x||'').trim()); const correctIndex=Number(req.body.correctIndex); if(options.length<2||correctIndex>=options.length) return res.send(layout('ط®ط·ط£',adminNav(req)+`<div class="error">ظ„ط§ط²ظ… ط¹ظ„ظ‰ ط§ظ„ط£ظ‚ظ„ ط§ط®طھظٹط§ط±ظٹظ†طŒ ظˆط§ظ„ط¥ط¬ط§ط¨ط© ط§ظ„طµط­ظٹط­ط© طھظƒظˆظ† ط¶ظ…ظ† ط§ظ„ط§ط®طھظٹط§ط±ط§طھ ط§ظ„ظ…ظƒطھظˆط¨ط©.</div>`)); exam.questions.push({id:nanoid(8),text:req.body.text,options,correctIndex,points:Number(req.body.points||1)}); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/questions/:qid/delete',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.questions=exam.questions.filter(q=>q.id!==req.params.qid); await store.updateExam(exam); res.redirect(303, `/admin/exams/${exam.id}`); }));
app.post('/admin/exams/:id/toggle',requireUser,asyncRoute(async(req,res)=>{ const exam=await getOwnedExam(req,res); if(!exam)return; exam.published=!exam.published; await store.updateExam(exam); res.redirect(303, req.get('referer')||'/admin'); }));
app.post('/admin/exams/:id/delete',requireUser,asyncRoute(async(req,res)=>{ await store.deleteExam(req.params.id,req.user.id); res.redirect(303, '/admin'); }));

app.get('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send(layout('ط؛ظٹط± ظ…طھط§ط­',`<div class="card"><h1>ط§ظ„ط§ظ…طھط­ط§ظ† ط؛ظٹط± ظ…طھط§ط­</h1><p>ط§ظ„ط±ط§ط¨ط· ط؛ظٹط± طµط­ظٹط­ ط£ظˆ ط§ظ„ط§ظ…طھط­ط§ظ† ط؛ظٹط± ظ…ظ†ط´ظˆط±.</p></div>`)); exam.questions=exam.questions||[]; const qs=exam.questions.map((q,i)=>`<div class="card"><h3>ط³${i+1}: ${esc(q.text)}</h3>${q.options.map((o,idx)=>`<label class="option"><input type="radio" name="q_${q.id}" value="${idx}" required> ${esc(o)}</label>`).join('')}</div>`).join(''); res.send(layout(exam.title,`<h1>${esc(exam.title)}</h1><form method="post"><div class="card"><label>ط§ظƒطھط¨ ط§ط³ظ…ظƒ</label><input name="studentName" required placeholder="ط§ظ„ط§ط³ظ… ط¨ط§ظ„ظƒط§ظ…ظ„" autofocus></div>${qs}<button class="btn ok">طھط³ظ„ظٹظ… ط§ظ„ط§ظ…طھط­ط§ظ†</button></form>`)); }));
app.post('/exam/:slug',asyncRoute(async(req,res)=>{ const exam=await store.getExamBySlug(req.params.slug); if(!exam||!exam.published) return res.status(404).send('Not found'); const owner=await store.getUserById(exam.ownerId); const ownerEmail=owner?owner.email:null; exam.questions=exam.questions||[]; let score=0,total=0; const answers={}; exam.questions.forEach(q=>{ total+=Number(q.points||1); const ans=Number(req.body[`q_${q.id}`]); answers[q.id]=Number.isFinite(ans)?ans:null; if(ans===q.correctIndex)score+=Number(q.points||1); }); const percent=total?Math.round((score/total)*100):0; const result={id:nanoid(10),examId:exam.id,ownerId:exam.ownerId,ownerEmail,examTitle:exam.title,studentName:req.body.studentName,score,total,percent,answers,createdAt:new Date().toISOString()}; await store.addResult(result); notifyResult(result).catch(err=>console.error('email error',err.message)); res.send(layout('ط§ظ„ظ†طھظٹط¬ط©',`<div class="card"><h1>طھظ… طھط³ظ„ظٹظ… ط§ظ„ط§ظ…طھط­ط§ظ†</h1><p>ط§ظ„ط§ط³ظ…: <b>${esc(result.studentName)}</b></p><h2>ط¯ط±ط¬طھظƒ: ${score} ظ…ظ† ${total}</h2><h2>ط§ظ„ظ†ط³ط¨ط©: ${percent}%</h2><p class="muted">طھظ… طھط³ط¬ظٹظ„ ط§ظ„ظ†طھظٹط¬ط©طŒ ظˆط³ظٹطھظ… ط¥ط±ط³ط§ظ„ظ‡ط§ ظ„طµط§ط­ط¨ ط§ظ„ط§ظ…طھط­ط§ظ† ط¹ظ„ظ‰ ط¥ظٹظ…ظٹظ„ظ‡ ط¥ط°ط§ ظƒط§ظ† ط¥ط±ط³ط§ظ„ ط§ظ„ط¥ظٹظ…ظٹظ„ ظ…طھظپط¹ظ„ظ‹ط§.</p></div>`)); }));
app.get('/admin/results',requireUser,asyncRoute(async(req,res)=>{ const results=await store.listResults(req.user.id); const rows=results.map(r=>`<tr><td>${esc(r.studentName)}</td><td>${esc(r.examTitle)}</td><td>${r.score}/${r.total}</td><td>${r.percent}%</td><td>${new Date(r.createdAt).toLocaleString('ar-EG')}</td></tr>`).join('')||'<tr><td colspan="5">ظ„ط§ طھظˆط¬ط¯ ظ†طھط§ط¦ط¬ ط¨ط¹ط¯</td></tr>'; res.send(layout('ط§ظ„ظ†طھط§ط¦ط¬',adminNav(req)+`<div class="card"><h1>ظ†طھط§ط¦ط¬ ط§ظ„ط·ظ„ط§ط¨</h1><p><a class="btn secondary" href="/admin/results.csv">طھط­ظ…ظٹظ„ CSV</a></p><table class="table"><thead><tr><th>ط§ظ„ط§ط³ظ…</th><th>ط§ظ„ط§ظ…طھط­ط§ظ†</th><th>ط§ظ„ط¯ط±ط¬ط©</th><th>ط§ظ„ظ†ط³ط¨ط©</th><th>ط§ظ„ظˆظ‚طھ</th></tr></thead><tbody>${rows}</tbody></table></div>`)); }));
app.get('/admin/results.csv',requireUser,asyncRoute(async(req,res)=>{ const results=await store.listResults(req.user.id); const header='studentName,examTitle,score,total,percent,createdAt\n'; const lines=results.map(r=>[r.studentName,r.examTitle,r.score,r.total,r.percent,r.createdAt].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'); res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="results.csv"'); res.send('\ufeff'+header+lines); }));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).send(layout('ط®ط·ط£',`<div class="error">ط­طµظ„ ط®ط·ط£ ظپظٹ ط§ظ„ط³ظٹط±ظپط±. ط±ط§ط¬ط¹ Logs.</div>`)); });


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
