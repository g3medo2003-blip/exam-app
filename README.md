# Exam Link App - Production Version

تطبيق امتحانات شبيه بجوجل فورم:

- تسجيل حساب لكل مستخدم/مدرس بالإيميل وكلمة السر.
- كل مستخدم يرى امتحاناته ونتائجه فقط.
- إنشاء امتحانات وأسئلة اختيار من متعدد.
- رابط لكل امتحان يفتحه الطلاب.
- الطالب يكتب اسمه، يحل، وتظهر له الدرجة فورًا.
- النتائج تظهر لصاحب الامتحان وتتبعث على إيميله إذا تم ضبط SMTP.
- يدعم Supabase PostgreSQL عن طريق `DATABASE_URL`.
- يظهر في أسفل الصفحات: تم التطوير بواسطة ahmed.

## تشغيل محليًا

```bash
npm install
npm start
```

افتح:

```text
http://localhost:3000/admin/register
```

لو لم تضف `DATABASE_URL` سيستخدم ملف JSON محلي للتجربة.

## Environment Variables على Render

```env
SESSION_SECRET=اكتب_سر_طويل_عشوائي
BASE_URL=https://your-app-name.onrender.com
DATABASE_URL=رابط_Postgres_من_Supabase

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-sender-email@gmail.com
SMTP_PASS=app-password
MAIL_FROM=your-sender-email@gmail.com
```

ملاحظة: النتيجة تذهب تلقائيًا إلى إيميل صاحب الحساب الذي أنشأ الامتحان، لذلك لا نحتاج `NOTIFY_EMAIL`.

## نشر مختصر

1. اعمل Supabase project وخذ `DATABASE_URL` من Database Settings.
2. ارفع المشروع على GitHub.
3. اعمل Web Service على Render.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. أضف Environment Variables.
7. بعد النشر افتح `/admin/register` واعمل حساب.
