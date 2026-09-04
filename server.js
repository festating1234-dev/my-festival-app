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

// ========== API 라우트 ==========

// 1. 모든 프로필 가져오기
app.get('/api/profiles', async (req, res) => {
    const { data, error } = await supabase.from('profiles').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. 회원가입
app.post('/api/users', async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .insert([req.body])
        .select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 3. 로그인
app.post('/api/login', async (req, res) => {
    const { nickname, password } = req.body;
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('nickname', nickname)
        .eq('password', password)
        .single();
    if (error || !data) return res.status(401).json({ error: 'Invalid credentials' });
    res.json(data);
});

// 4. 프로필 생성 (카드 등록)
app.post('/api/profiles', async (req, res) => {
    const { data, error } = await supabase
        .from('profiles')
        .insert([req.body])
        .select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 5. 좋아요 추가/삭제
app.post('/api/likes', async (req, res) => {
    const { user_id, card_id } = req.body;
    const { data: existing } = await supabase
        .from('likes')
        .select('*')
        .eq('user_id', user_id)
        .eq('card_id', card_id)
        .single();
    
    if (existing) {
        await supabase
            .from('likes')
            .delete()
            .eq('user_id', user_id)
            .eq('card_id', card_id);
        await supabase.rpc('decrement_likes', { card_id });
        res.json({ success: true, action: 'unliked' });
    } else {
        await supabase.from('likes').insert([{ user_id, card_id }]);
        await supabase.rpc('increment_likes', { card_id });
        res.json({ success: true, action: 'liked' });
    }
});

// 6. 매칭 신청
app.post('/api/matches', async (req, res) => {
    const { from_user_id, to_card_id, type } = req.body;
    const { data, error } = await supabase
        .from('matches')
        .insert([{ from_user_id, to_card_id, type }])
        .select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 7. 매칭 응답 (수락/거절)
app.put('/api/matches/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const { data, error } = await supabase
        .from('matches')
        .update({ status, responded_at: new Date() })
        .eq('id', id)
        .select();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data[0]);
});

// 8. 서버 상태 확인용 테스트 API
app.get('/api/test', (req, res) => {
    res.json({ message: '🚀 Supabase 연결 성공!' });
});

// 모든 요청을 index.html로 보내기
app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 서버 실행
app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중! http://localhost:${PORT}`);
});