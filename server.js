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

// ============================================================
//  이메일 인증 관련 API
// ============================================================

// 1. 이메일 도메인 검증
app.post('/api/check-email-domain', async (req, res) => {
    const { email, school } = req.body;
    
    console.log('📧 받은 email:', email);
    console.log('🏫 받은 school:', school);

    if (!email || !school) {
        return res.status(400).json({ error: '이메일과 학교 정보가 필요합니다.' });
    }
    
    const domain = email.split('@')[1];
    console.log('🌐 추출된 domain:', domain);

    if (!domain) {
        return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
    }

    try {
        const { data: domainData, error: domainError } = await supabase
            .from('university_domains')
            .select('school_name')
            .eq('domain', domain)
            .single();

        console.log('📊 domainData:', domainData);
        console.log('❌ domainError:', domainError);

        if (domainError || !domainData) {
            return res.status(400).json({ 
                valid: false, 
                message: '학교 이메일 도메인이 아닙니다. 해외대학은 문의해주세요.' 
            });
        }

        if (domainData.school_name !== school) {
            return res.status(400).json({ 
                valid: false, 
                message: '가입시 입력한 학교정보와 이메일 도메인이 일치하지 않습니다.' 
            });
        }

        const { data: existing, error: existError } = await supabase
            .from('email_verifications')
            .select('id')
            .eq('email', email)
            .eq('verified', true)
            .single();

        if (existing) {
            return res.status(400).json({ 
                valid: false, 
                message: '이미 인증된 이메일 주소입니다.' 
            });
        }

        res.json({ valid: true, school: domainData.school_name });
    } catch (err) {
        console.error('Email domain check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. 인증번호 발송
app.post('/api/send-verification', async (req, res) => {
    const { email, userId, school } = req.body;
    
    // 이메일 도메인 검증
    const domain = email.split('@')[1];
    const { data: domainData, error: domainError } = await supabase
        .from('university_domains')
        .select('school_name')
        .eq('domain', domain)
        .single();

    if (domainError || !domainData || domainData.school_name !== school) {
        return res.status(400).json({ error: '학교 이메일이 아닙니다.' });
    }

    // 이미 인증된 이메일인지 확인
    const { data: existing } = await supabase
        .from('email_verifications')
        .select('id')
        .eq('email', email)
        .eq('verified', true)
        .single();

    if (existing) {
        return res.status(400).json({ error: '이미 인증된 이메일입니다.' });
    }

    // 6자리 인증번호 생성
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10분 후 만료

    // 기존 인증번호 삭제 (갱신)
    await supabase
        .from('email_verifications')
        .delete()
        .eq('user_id', userId)
        .eq('email', email);

    // 새 인증번호 저장
    const { error: insertError } = await supabase
        .from('email_verifications')
        .insert([{ user_id: userId, email, code, expires_at: expiresAt }]);

    if (insertError) {
        console.error('Insert error:', insertError);
        return res.status(500).json({ error: '인증번호 저장 중 오류가 발생했습니다.' });
    }

    // TODO: 실제 이메일 발송 로직 (Mailtrap, Nodemailer 등)
    console.log(`📧 인증번호 발송: ${email} → ${code}`);

    res.json({ 
        success: true, 
        message: '인증번호가 이메일로 발송되었습니다.',
        code // 개발용, 실제로는 제거
    });
});

// 3. 인증번호 확인
app.post('/api/verify-email-code', async (req, res) => {
    const { userId, email, code } = req.body;

    try {
        const { data, error } = await supabase
            .from('email_verifications')
            .select('*')
            .eq('user_id', userId)
            .eq('email', email)
            .eq('code', code)
            .eq('verified', false)
            .single();

        if (error || !data) {
            return res.status(400).json({ error: '올바르지 않은 인증번호입니다.' });
        }

        if (new Date(data.expires_at) < new Date()) {
            return res.status(400).json({ error: '인증번호가 만료되었습니다. 다시 요청해주세요.' });
        }

        // 인증 완료 처리
        await supabase
            .from('email_verifications')
            .update({ verified: true })
            .eq('id', data.id);

        // users 테이블에 이메일 인증 상태 업데이트
        await supabase
            .from('users')
            .update({ email_verified: true, email: email })
            .eq('id', userId);

        res.json({ success: true, message: '이메일 인증이 완료되었습니다!' });
    } catch (err) {
        console.error('Verify code error:', err);
        res.status(500).json({ error: err.message });
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

// 1-7. 모든 사용자 목록 조회
app.get('/api/users', async (req, res) => {
    try {
        const { data, error } = await supabase.from('users').select('*');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Users fetch error:', err);
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