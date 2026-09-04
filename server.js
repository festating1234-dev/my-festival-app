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
// Supabase 연결 상태 확인용 (간단)
app.get('/api/supabase-ping', async (req, res) => {
    try {
        // 아무 쿼리나 실행해보기 (존재하지 않는 테이블이라도 됨)
        const { error } = await supabase.from('users').select('id', { head: true, count: 'exact' });
        if (error) {
            return res.json({ 
                status: '❌ Supabase 연결은 되었지만 쿼리 실패', 
                error: error.message,
                hint: 'RLS 정책 때문일 수 있습니다. 테이블의 RLS를 임시로 비활성화해보세요.'
            });
        }
        res.json({ status: '✅ Supabase 연결 및 쿼리 성공!' });
    } catch (err) {
        res.json({ 
            status: '❌ Supabase 연결 자체가 실패', 
            error: err.message,
            stack: err.stack
        });
    }
});