require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------- 미들웨어 ----------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------------------- Supabase 클라이언트 ----------------------
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// ============================================================
//  1.  사용자 관련 API
// ============================================================

// 1-1. 닉네임 중복 확인
app.get('/api/users/check-nickname', async (req, res) => {
    const { nickname } = req.query;
    if (!nickname) {
        return res.status(400).json({ error: '닉네임을 입력해주세요.' });
    }
    try {
        const { data, error } = await supabase
            .from('users')
            .select('nickname')
            .eq('nickname', nickname)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }
        res.json({ exists: !!data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-2. 회원가입
app.post('/api/users', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .insert([req.body])
            .select();

        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json(data[0]);
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 1-3. 로그인
app.post('/api/login', async (req, res) => {
    const { nickname, password } = req.body;

    if (!nickname || !password) {
        return res.status(400).json({ error: '닉네임과 비밀번호를 입력해주세요.' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('nickname', nickname)
            .eq('password', password)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
            }
            throw error;
        }

        if (!data) {
            return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        }

        res.json(data);
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 1-4. 특정 사용자 정보 조회 (★ 추가됨)
app.get('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
            }
            throw error;
        }
        res.json(data);
    } catch (err) {
        console.error('User fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 1-5. 사용자 정보 수정 (선택)
app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('users')
            .update(req.body)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (data.length === 0) {
            return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        }
        res.json(data[0]);
    } catch (err) {
        console.error('User update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 1-6. 사용자 삭제 (선택)
app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('User delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  2.  프로필(카드) 관련 API
// ============================================================

// 2-1. 전체 프로필 조회
app.get('/api/profiles', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Profile fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2-2. 카드 등록
app.post('/api/profiles', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .insert([req.body])
            .select();

        if (error) {
            console.error('Profile insert error:', error);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json(data[0]);
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 2-3. 카드 수정
app.put('/api/profiles/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .update(req.body)
            .eq('id', id)
            .select();

        if (error) throw error;
        if (data.length === 0) {
            return res.status(404).json({ error: '해당 카드를 찾을 수 없습니다.' });
        }
        res.json(data[0]);
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2-4. 카드 삭제
app.delete('/api/profiles/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('profiles')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Profile delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  3.  좋아요(찜) 관련 API
// ============================================================

// 3-1. 좋아요 목록 조회 (★ 추가됨)
app.get('/api/likes', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('likes')
            .select('*');

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Likes fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3-2. 좋아요 추가/삭제 (찜 토글)
app.post('/api/likes', async (req, res) => {
    const { user_id, card_id } = req.body;

    if (!user_id || !card_id) {
        return res.status(400).json({ error: 'user_id와 card_id가 필요합니다.' });
    }

    try {
        // 이미 좋아요가 있는지 확인
        const { data: existing, error: findError } = await supabase
            .from('likes')
            .select('*')
            .eq('user_id', user_id)
            .eq('card_id', card_id)
            .single();

        if (findError && findError.code !== 'PGRST116') {
            throw findError;
        }

        if (existing) {
            // 좋아요 삭제
            const { error: deleteError } = await supabase
                .from('likes')
                .delete()
                .eq('user_id', user_id)
                .eq('card_id', card_id);

            if (deleteError) throw deleteError;

            // 좋아요 수 감소
            await supabase.rpc('decrement_likes', { card_id });

            return res.json({ success: true, action: 'unliked' });
        } else {
            // 좋아요 추가
            const { error: insertError } = await supabase
                .from('likes')
                .insert([{ user_id, card_id }]);

            if (insertError) throw insertError;

            // 좋아요 수 증가
            await supabase.rpc('increment_likes', { card_id });

            return res.json({ success: true, action: 'liked' });
        }
    } catch (err) {
        console.error('Like toggle error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  4.  매칭 관련 API
// ============================================================

// 4-1. 매칭 목록 조회 (★ 추가됨)
app.get('/api/matches', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('matches')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Matches fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4-2. 매칭 신청
app.post('/api/matches', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('matches')
            .insert([req.body])
            .select();

        if (error) {
            console.error('Match insert error:', error);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json(data[0]);
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 4-3. 매칭 응답 (수락/거절)
app.put('/api/matches/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: '유효한 상태가 아닙니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('matches')
            .update({ status, responded_at: new Date() })
            .eq('id', id)
            .select();

        if (error) throw error;
        if (data.length === 0) {
            return res.status(404).json({ error: '매칭을 찾을 수 없습니다.' });
        }
        res.json(data[0]);
    } catch (err) {
        console.error('Match update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  5.  테스트용 API
// ============================================================

app.get('/api/supabase-ping', async (req, res) => {
    try {
        const { error } = await supabase
            .from('users')
            .select('id', { head: true, count: 'exact' });
        if (error) {
            return res.json({
                status: '❌ Supabase 연결은 되었지만 쿼리 실패',
                error: error.message,
                hint: 'RLS 정책이나 API 노출 설정을 확인하세요.'
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

app.get('/api/supabase-test', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
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

app.get('/api/test', (req, res) => {
    res.json({ message: '서버가 살아있습니다! 🎉' });
});

// ============================================================
//  6.  모든 API 이외의 요청은 index.html (SPA)
// ============================================================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------- 서버 실행 ----------------------
app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중! http://localhost:${PORT}`);
    console.log(`🔗 Supabase URL: ${process.env.SUPABASE_URL ? '✅ 설정됨' : '❌ 설정 안 됨'}`);
    console.log(`🔑 Supabase Key: ${process.env.SUPABASE_ANON_KEY ? '✅ 설정됨' : '❌ 설정 안 됨'}`);
});