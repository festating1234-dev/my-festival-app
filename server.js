require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Supabase 클라이언트
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// 테스트 API
app.get('/api/test', (req, res) => {
    res.json({ message: '🚀 Supabase 연결 성공!' });
});

// 모든 요청을 index.html로
app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중! http://localhost:${PORT}`);
});