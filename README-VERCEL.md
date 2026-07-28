# نشر التطبيق مجانًا على Vercel

هذه نسخة جاهزة للنشر على Vercel بدل Render.

## Environment Variables في Vercel

أضف:

```env
DATABASE_URL=رابط Supabase
SESSION_SECRET=exam-app-secret-123456789
BASE_URL=https://your-project.vercel.app
```

اختياري لإرسال الإيميل:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=app-password
MAIL_FROM=your-email@gmail.com
```

بعد النشر افتح:

```text
/admin/register
```
