require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Supabase 클라이언트
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ====== Supabase 연결 테스트 API ======
app.get('/api/supabase-test', async (req, res) => {
    try {
        const { data, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
        if (error) throw error;
        res.json({ 
            message: '✅ Supabase 연결 성공!', 
            userCount: data?.length || 0 
        });
    } catch (err) {
        res.status(500).json({ 
            message: '❌ Supabase 연결 실패', 
            error: err.message 
        });
    }
});

// ====== 기존 API들 ======
app.get('/api/test', (req, res) => {
    res.json({ message: '서버가 살아있습니다! 🎉' });
});

// ★ Express 4에서는 이렇게 간단합니다! ★
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중! http://localhost:${PORT}`);
    console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL ? '✅ 설정됨' : '❌ 설정 안 됨'}`);
});