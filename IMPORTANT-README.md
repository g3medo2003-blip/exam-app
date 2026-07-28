# Exam App Final Complete

هذه هي النسخة النهائية بكل التعديلات:

- خلفية متحركة.
- أيقونات SVG حقيقية تظهر داخل التطبيق.
- تصميم احترافي Responsive مناسب لكل الشاشات.
- صوت خفيف عند الضغط على الأزرار.
- فوتر داخل برواز: تم التطوير بواسطة ahmed😎
- نسخ رابط الامتحان بالرابط الحالي الصحيح تلقائيًا.
- الامتحان يظل شغال حتى بعد الخروج من الحساب أو التطبيق طالما منشور.
- إيقاف الامتحان فقط من زر إيقاف النشر.
- حفظ النتائج في Supabase حتى يتم حذفها يدويًا.
- حذف نتيجة واحدة أو حذف كل النتائج.
- استيراد الأسئلة من Excel / CSV / TXT / PDF.

## ملفات مهمة

- server.js
- package.json
- api/index.js
- vercel.json

## Environment Variables المطلوبة في Vercel

DATABASE_URL=رابط Supabase Transaction Pooler
SESSION_SECRET=exam-app-secret-123456789

يفضل أن يكون DATABASE_URL من Transaction pooler ويحتوي على pooler.supabase.com و port 6543.

## تنبيه PDF

PDF النصي يعمل. أما PDF الصور/السكان يحتاج OCR ولن يتم قراءته تلقائيًا بدون تحويله لنص أو Excel.
