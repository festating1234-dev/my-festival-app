require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------- 미들웨어 ----------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------------------- Multer 설정 (파일 업로드) ----------------------
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB 제한
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('이미지 파일만 업로드 가능합니다.'));
        }
    }
});

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

        // ★★★ 정지 확인 ★★★
        if (data.is_banned) {
            return res.status(403).json({
                error: '이용 정지',
                message: '지속적인 신고로 1달간 이용이 정지되었습니다. 문의사항이 있다면 하단 "문의하기" 버튼을 통해 연락 부탁드립니다.'
            });
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

// 2. 인증번호 발송 (실제 이메일 발송)
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
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

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

    // ===== ★★★ 실제 이메일 발송 (nodemailer + Mailtrap) ★★★ =====
    try {
        const transporter = nodemailer.createTransport({
            host: process.env.MAILTRAP_HOST,
            port: parseInt(process.env.MAILTRAP_PORT) || 2525,
            auth: {
                user: process.env.MAILTRAP_USER,
                pass: process.env.MAILTRAP_PASS
            }
        });

        const mailOptions = {
            from: '"페스타팅" <noreply@festating.com>',
            to: email,
            subject: '[페스타팅] 이메일 인증번호',
            html: `
                <div style="font-family: 'Noto Sans KR', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f5f5f5; border-radius: 10px;">
                    <h2 style="color: #a855f7;">🎉 페스타팅 이메일 인증</h2>
                    <p style="color: #333;">안녕하세요! 페스타팅입니다.</p>
                    <p style="color: #333;">아래 인증번호를 입력하시면 이메일 인증이 완료됩니다.</p>
                    <div style="text-align: center; padding: 16px; background: white; border-radius: 8px; margin: 16px 0;">
                        <span style="font-size: 28px; font-weight: 700; color: #a855f7; letter-spacing: 6px;">${code}</span>
                    </div>
                    <p style="color: #888; font-size: 12px;">⏰ 이 인증번호는 10분 후에 만료됩니다.</p>
                    <p style="color: #888; font-size: 12px;">문의사항이 있으시면 카카오톡 ID: <strong>festivalting</strong>으로 연락주세요.</p>
                    <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
                    <p style="color: #aaa; font-size: 11px; text-align: center;">본 메일은 발신 전용입니다. 회신하실 필요가 없습니다.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 인증번호 발송 완료: ${email} → ${code}`);

    } catch (emailError) {
        console.error('Email send error:', emailError);
        return res.status(500).json({ 
            error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.' 
        });
    }

    res.json({ 
        success: true, 
        message: '인증번호가 이메일로 발송되었습니다.'
    });
});

// 3. 인증번호 확인
app.post('/api/verify-email-code', async (req, res) => {
    const { userId, email, code } = req.body;

    // 필수 값 확인
    if (!userId || !email || !code) {
        return res.status(400).json({ error: 'userId, email, code가 모두 필요합니다.' });
    }

    try {
        // 인증번호 조회 (사용자 ID, 이메일, 코드, 미인증 상태)
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

        // 만료 시간 확인
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
//  학생증 인증 관련 API
// ============================================================

// 1. 학생증 이미지 업로드
app.post('/api/upload-card', upload.single('cardImage'), async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }
    if (!req.file) {
        return res.status(400).json({ error: '이미지 파일이 필요합니다.' });
    }

    try {
        const ext = path.extname(req.file.originalname);
        const fileName = `${uuidv4()}${ext}`;
        const filePath = `${userId}/${fileName}`;

        const { data, error } = await supabase.storage
            .from('student-cards')
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                cacheControl: '3600'
            });

        if (error) throw error;

        const publicUrl = supabase.storage
            .from('student-cards')
            .getPublicUrl(filePath).data.publicUrl;

        // users 테이블에 card_status 및 card_image_url 업데이트
        await supabase
            .from('users')
            .update({ 
                card_status: 'pending',
                card_image_url: publicUrl
            })
            .eq('id', userId);

        res.json({ 
            success: true, 
            message: '학생증이 제출되었습니다. 관리자 확인 후 승인됩니다.',
            imageUrl: publicUrl
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: '업로드 중 오류가 발생했습니다.' });
    }
});

// 2. 관리자 승인/반려
app.put('/api/admin/card/:userId', async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: '유효하지 않은 상태입니다.' });
    }

    try {
        const { error } = await supabase
            .from('users')
            .update({ card_status: status })
            .eq('id', userId);

        if (error) throw error;

        res.json({ success: true, message: `학생증이 ${status === 'approved' ? '승인' : '반려'}되었습니다.` });
    } catch (error) {
        console.error('Admin approve error:', error);
        res.status(500).json({ error: error.message });
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

// 2-2. 카드 등록 (중복 체크 추가)
app.post('/api/profiles', async (req, res) => {
    const { user_id, type } = req.body;
    try {
        // ★★★ 동일 사용자 + 동일 타입 카드 존재 여부 확인 ★★★
        const { data: existing, error: checkError } = await supabase
            .from('profiles')
            .select('id')
            .eq('user_id', user_id)
            .eq('type', type)
            .maybeSingle();

        if (checkError) throw checkError;

        if (existing) {
            return res.status(400).json({ error: '이미 해당 유형의 카드가 존재합니다.' });
        }

        // 카드 등록
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
//  신고 관련 API
// ============================================================

// 1. 중복 신고 확인 (신고 버튼 클릭 시 바로 체크)
app.get('/api/reports/check-duplicate', async (req, res) => {
    const { reporter_user_id, target_card_id } = req.query;

    if (!reporter_user_id || !target_card_id) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // ★ .maybeSingle() 대신 select + limit(1) 사용
        const { data, error } = await supabase
            .from('reports')
            .select('id')
            .eq('reporter_user_id', reporter_user_id)
            .eq('target_card_id', target_card_id)
            .limit(1);

        if (error) throw error;

        res.json({ duplicate: data && data.length > 0 });
    } catch (error) {
        console.error('Check duplicate error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 신고 접수 (중복 체크 포함)
app.post('/api/reports', async (req, res) => {
    const { reporter_user_id, target_user_id, target_card_id, reason, description } = req.body;

    if (!reporter_user_id || !target_user_id || !target_card_id || !reason) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // ★ 중복 신고 체크 (select + limit(1))
        const { data: existing, error: checkError } = await supabase
            .from('reports')
            .select('id')
            .eq('reporter_user_id', reporter_user_id)
            .eq('target_card_id', target_card_id)
            .limit(1);

        if (checkError) throw checkError;

        if (existing && existing.length > 0) {
            return res.status(400).json({ error: '이미 신고한 카드입니다.' });
        }

        // 신고 저장
        const { data, error } = await supabase
            .from('reports')
            .insert([{
                reporter_user_id,
                target_user_id,
                target_card_id,
                reason,
                description: description || null,
                status: 'pending'
            }])
            .select();

        if (error) throw error;

        res.json({ success: true, message: '신고가 접수되었습니다.' });
    } catch (error) {
        console.error('Report error:', error);
        res.status(500).json({ error: '신고 접수 중 오류가 발생했습니다.' });
    }
});

// 3. 관리자용 신고 목록 조회
app.get('/api/admin/reports', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('reports')
            .select(`
                *,
                reporter:reporter_user_id(nickname, school),
                target:target_user_id(nickname, school)
            `)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Admin reports error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//  알림 관련 API 
// ============================================================

// 1. 사용자 알림 목록 조회 (최신순)
app.get('/api/notifications', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Notifications fetch error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 읽지 않은 알림 개수 조회
app.get('/api/notifications/unread-count', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { count, error } = await supabase
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) throw error;
        res.json({ count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. 알림 읽음 처리 (단일)
app.put('/api/notifications/:id/read', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Read notification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. 모든 알림 읽음 처리
app.put('/api/notifications/read-all', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Read all notifications error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. 관리자 공지 발송
app.post('/api/admin/notifications', async (req, res) => {
    const { userIds, title, message, link } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: '수신자 목록이 필요합니다.' });
    }
    if (!title || !message) {
        return res.status(400).json({ error: '제목과 내용이 필요합니다.' });
    }

    try {
        const notifications = userIds.map(userId => ({
            user_id: userId,
            type: 'admin_notice',
            title,
            message,
            link: link || null,
            is_read: false
        }));

        const { data, error } = await supabase
            .from('notifications')
            .insert(notifications)
            .select();

        if (error) throw error;
        res.json({ success: true, count: data.length });
    } catch (error) {
        console.error('Admin notice error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 0. 단일 알림 생성 (시스템 내부용)
app.post('/api/notifications', async (req, res) => {
    const { user_id, type, title, message, link, card_id } = req.body;
    if (!user_id || !type || !title || !message) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('notifications')
            .insert([{ 
                user_id, 
                type, 
                title, 
                message, 
                link: link || null, 
                card_id: card_id || null,  // ← 추가됨
                is_read: false 
            }])
            .select();

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (error) {
        console.error('Create notification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//  관리자: 이용 정지 / 정지 관리 API
// ============================================================

// 1. 사용자 이용 정지 (모든 카드 삭제 + 정지 사유 저장)
app.put('/api/admin/users/:id/ban', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
        return res.status(400).json({ error: '정지 사유가 필요합니다.' });
    }

    try {
        // 1. 해당 사용자의 모든 프로필(카드) 삭제
        const { error: deleteError } = await supabase
            .from('profiles')
            .delete()
            .eq('user_id', id);

        if (deleteError) throw deleteError;

        // 2. 사용자 정지 처리 (정지 사유 + 만료일 = 30일 후)
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        const { error: updateError } = await supabase
            .from('users')
            .update({
                is_banned: true,
                ban_reason: reason,
                ban_expires_at: expiresAt.toISOString()
            })
            .eq('id', id);

        if (updateError) throw updateError;

        // 3. 해당 사용자의 좋아요, 매칭 데이터도 정리 (선택)
        await supabase.from('likes').delete().eq('user_id', id);
        await supabase.from('matches').delete().or(`from_user_id.eq.${id},to_card_id.in.(SELECT id FROM profiles WHERE user_id = ${id})`);

        res.json({
            success: true,
            message: '사용자가 정지되었고, 모든 카드가 삭제되었습니다.',
            expires_at: expiresAt
        });
    } catch (error) {
        console.error('Ban error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 정지된 사용자 목록 조회 (관리자용)
app.get('/api/admin/banned-users', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select(`
                id,
                nickname,
                school,
                is_banned,
                ban_reason,
                ban_expires_at,
                profiles:profiles(user_id, id, type, emoji, school, grade, age, gender, height, detail, created_at)
            `)
            .eq('is_banned', true)
            .order('nickname', { ascending: true });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Banned users error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. 정지 해제
app.put('/api/admin/users/:id/unban', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('users')
            .update({
                is_banned: false,
                ban_reason: null,
                ban_expires_at: null
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, message: '정지가 해제되었습니다.' });
    } catch (error) {
        console.error('Unban error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. 정지 기간 변경 (연장/단축)
app.put('/api/admin/users/:id/ban-duration', async (req, res) => {
    const { id } = req.params;
    const { days } = req.body; // 양수: 연장, 음수: 단축

    if (typeof days !== 'number') {
        return res.status(400).json({ error: '유효한 일수가 필요합니다.' });
    }

    try {
        // 현재 만료일 조회
        const { data: user, error: fetchError } = await supabase
            .from('users')
            .select('ban_expires_at')
            .eq('id', id)
            .single();

        if (fetchError) throw fetchError;

        const currentExpiry = new Date(user.ban_expires_at);
        currentExpiry.setDate(currentExpiry.getDate() + days);

        const { error: updateError } = await supabase
            .from('users')
            .update({ ban_expires_at: currentExpiry.toISOString() })
            .eq('id', id);

        if (updateError) throw updateError;

        res.json({
            success: true,
            message: `정지 기간이 ${days > 0 ? days + '일 연장' : Math.abs(days) + '일 단축'}되었습니다.`,
            new_expires_at: currentExpiry
        });
    } catch (error) {
        console.error('Ban duration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 신고 반려 (status를 'dismissed'로 변경)
app.put('/api/admin/reports/:id/dismiss', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('reports')
            .update({ status: 'dismissed' })
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: '신고가 반려되었습니다.' });
    } catch (error) {
        console.error('Dismiss report error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. 카드 삭제 (이미 있음 - DELETE /api/profiles/:id)
// 이미 존재하므로 추가 불필요

// ============================================================
//  ★★★ 이 부분은 반드시 파일의 가장 마지막에 위치! ★★★
//  모든 API 이외의 요청은 index.html (SPA)
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