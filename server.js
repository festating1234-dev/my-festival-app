require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
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
//  매칭권 관련 헬퍼 함수
// ============================================================

// 매칭권 비용 계산
// 반환: { a: A가 쓸 매칭권, b: B가 쓸 매칭권 }
function calculateTicketCost(cardType, matchType) {
    // 동성친구: A만 1장
    if (cardType === 'same') {
        return { a: 1, b: 0 };
    }
    // 슈퍼매칭: A만 2장
    if (matchType === 'premium') {
        return { a: 2, b: 0 };
    }
    // 일반매칭: A 1장 + B 1장
    return { a: 1, b: 1 };
}

// 만료된 pending 매칭 처리 (Lazy Evaluation)
// - 특정 유저와 관련된 만료된 매칭을 찾아 A의 매칭권 환급 + status='expired'
async function processExpiredMatches(userId) {
    try {
        // 해당 유저의 카드 ID 목록
        const { data: myCards } = await supabase
            .from('profiles')
            .select('id')
            .eq('user_id', userId);

        const myCardIds = (myCards || []).map(c => c.id);

        // 만료된 pending 매칭 조회 (내가 신청자이거나, 내 카드가 수신 대상인 경우)
        let query = supabase
            .from('matches')
            .select('*')
            .eq('status', 'pending')
            .lt('expires_at', new Date().toISOString());

        if (myCardIds.length > 0) {
            query = query.or(`from_user_id.eq.${userId},to_card_id.in.(${myCardIds.join(',')})`);
        } else {
            query = query.eq('from_user_id', userId);
        }

        const { data: expiredMatches } = await query;

        if (!expiredMatches || expiredMatches.length === 0) return;

        // 각 만료 매칭 처리
        for (const match of expiredMatches) {
            // A의 매칭권 환급
            if (match.a_tickets_used > 0) {
                const { data: fromUser } = await supabase
                    .from('users')
                    .select('free_tickets')
                    .eq('id', match.from_user_id)
                    .single();

                if (fromUser) {
                    await supabase
                        .from('users')
                        .update({ free_tickets: (fromUser.free_tickets || 0) + match.a_tickets_used })
                        .eq('id', match.from_user_id);
                }
            }

            // 매칭 상태 만료 처리
            await supabase
                .from('matches')
                .update({ status: 'expired', responded_at: new Date().toISOString() })
                .eq('id', match.id);

            // A에게 알림
            await supabase.from('notifications').insert([{
                user_id: match.from_user_id,
                type: 'match_expired',
                title: '⏰ 매칭이 자동 취소되었어요',
                message: '매칭 상대방의 무응답으로 매칭이 자동 취소되었어요. 사용했던 매칭권은 환급되었어요.',
                link: 'matching',
                is_read: false
            }]);

            console.log(`⏰ 매칭 ${match.id} 만료 처리 완료 (A 환급: ${match.a_tickets_used}장)`);
        }
    } catch (error) {
        console.error('Process expired matches error:', error);
    }
}

// ---------------------- 추천인/이벤트 코드 설정 ----------------------

// 6자리 랜덤 코드 생성 (숫자 + 소문자)
function generateReferralCode() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// 중복되지 않는 고유 코드 생성
async function getUniqueReferralCode() {
    for (let i = 0; i < 10; i++) {
        const code = generateReferralCode();
        const { data } = await supabase
            .from('users')
            .select('id')
            .eq('referral_code', code)
            .limit(1);
        if (!data || data.length === 0) return code;
    }
    throw new Error('추천인 코드 생성 실패');
}


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

// 1-8. 추천인 코드 유효성 확인 (개인정보 노출 방지)
app.get('/api/users/check-referral-code', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ error: '코드를 입력해주세요.' });
    }
    try {
        const { data, error } = await supabase
            .from('users')
            .select('id')
            .eq('referral_code', code)
            .limit(1);
        
        if (error) throw error;
        
        // 존재 여부만 반환 (닉네임, 학교 등 개인정보는 절대 반환하지 않음)
        res.json({ valid: data && data.length > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-10. 유저의 추천인 코드 보장 (기존 유저가 코드가 없을 때 생성)
app.post('/api/users/:id/ensure-referral-code', async (req, res) => {
    const { id } = req.params;
    try {
        const { data: user } = await supabase
            .from('users')
            .select('referral_code')
            .eq('id', id)
            .single();
        
        if (user?.referral_code) {
            return res.json({ referral_code: user.referral_code });
        }
        
        // 코드 생성
        const newCode = await getUniqueReferralCode();
        await supabase
            .from('users')
            .update({ referral_code: newCode })
            .eq('id', id);
        
        res.json({ referral_code: newCode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 1-2. 회원가입 (추천인/이벤트 코드 처리 포함)
app.post('/api/users', async (req, res) => {
    try {
        const userData = { ...req.body };
        
        // 1. 프론트에서 넘어온 추천인/이벤트 코드 분리
        const usedReferralCode = userData.used_referral_code;
        delete userData.used_referral_code;
        delete userData.referral_code; // 혹시 몰라서 제거
        
        // 2. 내 추천인 코드 생성
        const myReferralCode = await getUniqueReferralCode();
        
        // 3. 초기 매칭권 계산
        let initialTickets = 0;
        
        // 3-2. 추천인 코드 확인
        let referrer = null;
        if (usedReferralCode) {
            const { data: referrerData } = await supabase
                .from('users')
                .select('id, nickname, free_tickets, invited_count')
                .eq('referral_code', usedReferralCode)
                .limit(1);
            
            if (referrerData && referrerData.length > 0) {
                referrer = referrerData[0];
                initialTickets += 1; // 신규 가입자 +1
            }
        }
        
        // 4. 유저 데이터 세팅
        userData.referral_code = myReferralCode;
        userData.free_tickets = initialTickets;
        userData.invited_count = 0;
        if (referrer) userData.referrer_user_id = referrer.id;
        
        // 5. 유저 생성
        const { data, error } = await supabase
            .from('users')
            .insert([userData])
            .select();
        
        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(400).json({ error: error.message });
        }
        
        const newUser = data[0];
        
        // 6. 추천인 보상 처리
        if (referrer) {
            // 6-1. 추천인에게 매칭권 +1, 초대 수 +1
            await supabase
                .from('users')
                .update({
                    free_tickets: (referrer.free_tickets || 0) + 1,
                    invited_count: (referrer.invited_count || 0) + 1
                })
                .eq('id', referrer.id);
            
            // 6-2. 추천인에게 알림 발송
            await supabase.from('notifications').insert([{
                user_id: referrer.id,
                type: 'referral',
                title: '🌟 나를 추천인으로 입력한 친구가 있어요!',
                message: '회원님이 추천한 친구가 가입했어요! 나와 친구 모두 무료매칭권 1개가 지급되었어요!',
                link: 'mypage',
                is_read: false
            }]);
            
            console.log(`✅ 추천인 보상: ${referrer.nickname}님 +1매칭권`);
        }
        
        res.status(201).json(newUser);
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 1-3. 로그인 (관리자 플래그 포함)
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

        // 정지 확인
        if (data.is_banned) {
            return res.status(403).json({
                error: '이용 정지',
                message: '지속적인 신고로 1달간 이용이 정지되었습니다. 문의사항이 있다면 하단 "문의하기" 버튼을 통해 연락 부탁드립니다.'
            });
        }

        // ★ 관리자 여부 명시적으로 포함
        res.json({
            ...data,
            is_admin: data.is_admin === true
        });
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

// 2. 인증번호 발송 (1분 쿨다운 + 하루 5회 제한 + 5분 만료)
app.post('/api/send-verification', async (req, res) => {
    const { email, userId, school } = req.body;

    if (!email || !userId) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // ===== 1. 유저 정보 조회 =====
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('email_verify_send_count, email_verify_reset_at, email_verify_last_sent_at')
            .eq('id', userId)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        }

        const now = new Date();

        // ===== 2. 카운트 초기화 필요 여부 확인 (다음 자정 지났으면 리셋) =====
        let sendCount = user.email_verify_send_count || 0;
        let resetAt = user.email_verify_reset_at ? new Date(user.email_verify_reset_at) : null;

        if (!resetAt || now > resetAt) {
            sendCount = 0;
            // 다음 자정 계산
            const nextMidnight = new Date(now);
            nextMidnight.setHours(24, 0, 0, 0);
            resetAt = nextMidnight;
        }

        // ===== 3. 하루 5회 제한 확인 =====
        if (sendCount >= 5) {
            return res.status(429).json({
                error: '이메일 전송 횟수를 초과했습니다. 문의하기로 연락주세요.',
                code: 'MAX_SEND_EXCEEDED',
                reset_at: resetAt
            });
        }

        // ===== 4. 1분 쿨다운 확인 =====
        if (user.email_verify_last_sent_at) {
            const lastSent = new Date(user.email_verify_last_sent_at);
            const diffSec = Math.floor((now - lastSent) / 1000);
            if (diffSec < 60) {
                return res.status(429).json({
                    error: `잠시 후 다시 시도해주세요. (${60 - diffSec}초 후 재발송 가능)`,
                    code: 'COOLDOWN',
                    remaining_seconds: 60 - diffSec
                });
            }
        }

        // ===== 5. 이메일 도메인 검증 =====
        const domain = email.split('@')[1];
        const { data: domainData, error: domainError } = await supabase
            .from('university_domains')
            .select('school_name')
            .eq('domain', domain)
            .single();

        if (domainError || !domainData || domainData.school_name !== school) {
            return res.status(400).json({ error: '학교 이메일이 아닙니다.' });
        }

        // ===== 6. 이미 인증된 이메일인지 확인 =====
        const { data: existing } = await supabase
            .from('email_verifications')
            .select('id')
            .eq('email', email)
            .eq('verified', true)
            .single();

        if (existing) {
            return res.status(400).json({ error: '이미 인증된 이메일입니다.' });
        }

        // ===== 7. 인증번호 생성 (5분 만료) =====
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // ★ 5분

        // 기존 인증번호 삭제
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

        // ===== 8. Brevo로 이메일 발송 =====
        try {
            const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'api-key': process.env.BREVO_API_KEY,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    sender: {
                        name: process.env.BREVO_SENDER_NAME || '페스타팅',
                        email: process.env.BREVO_SENDER_EMAIL
                    },
                    to: [{ email: email }],
                    subject: '[페스타팅] 이메일 인증번호',
                    htmlContent: `
                        <div style="font-family: 'Noto Sans KR', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; background: #f5f5f5; border-radius: 10px;">
                            <h2 style="color: #a855f7;">🎉 페스타팅 이메일 인증</h2>
                            <p style="color: #333;">안녕하세요! 페스타팅입니다.</p>
                            <p style="color: #333;">아래 인증번호를 입력하시면 이메일 인증이 완료됩니다.</p>
                            <div style="text-align: center; padding: 16px; background: white; border-radius: 8px; margin: 16px 0;">
                                <span style="font-size: 28px; font-weight: 700; color: #a855f7; letter-spacing: 6px;">${code}</span>
                            </div>
                            <p style="color: #888; font-size: 12px;">⏰ 이 인증번호는 <strong>5분</strong> 후에 만료됩니다.</p>
                            <p style="color: #888; font-size: 12px;">스팸함에 들어갔다면, 스팸 해제 부탁드려요!</p>
                            <p style="color: #888; font-size: 12px;">문의사항이 있으시면 카카오톡 ID: <strong>festivalting</strong>으로 연락주세요.</p>
                            <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
                            <p style="color: #aaa; font-size: 11px; text-align: center;">본 메일은 발신 전용입니다. 회신하실 필요가 없습니다.</p>
                        </div>
                    `
                })
            });

            if (!brevoResponse.ok) {
                const errorBody = await brevoResponse.text();
                console.error('Brevo API error:', brevoResponse.status, errorBody);
                throw new Error(`Brevo API 오류 (${brevoResponse.status})`);
            }

            console.log(`📧 Brevo 인증번호 발송 완료: ${email} → ${code} (오늘 ${sendCount + 1}회차)`);
        } catch (emailError) {
            console.error('Brevo email send error:', emailError);
            return res.status(500).json({
                error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.'
            });
        }

        // ===== 9. 유저 발송 정보 업데이트 =====
        await supabase
            .from('users')
            .update({
                email_verify_send_count: sendCount + 1,
                email_verify_reset_at: resetAt.toISOString(),
                email_verify_last_sent_at: now.toISOString()
            })
            .eq('id', userId);

        res.json({
            success: true,
            message: '인증번호가 이메일로 발송되었습니다.',
            send_count: sendCount + 1,
            remaining_sends: 5 - (sendCount + 1)
        });
    } catch (err) {
        console.error('Send verification error:', err);
        res.status(500).json({ error: err.message });
    }
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

// 2-4. 카드 삭제 (관련 데이터 함께 정리)
app.delete('/api/profiles/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. 관련 좋아요(찜) 삭제
        await supabase
            .from('likes')
            .delete()
            .eq('card_id', id);

        // 2. 관련 매칭 삭제 (pending 상태만 - 성사/거절된 이력은 보존)
        await supabase
            .from('matches')
            .delete()
            .eq('to_card_id', id)
            .eq('status', 'pending');

        // 3. 프로필(카드) 삭제
        const { error } = await supabase
            .from('profiles')
            .delete()
            .eq('id', id);

        if (error) throw error;

        console.log(`🗑️ 카드 ${id} 삭제 완료 (관련 좋아요/매칭 정리됨)`);
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

// 4-1. 매칭 목록 조회 (Lazy 만료 처리 포함)
app.get('/api/matches', async (req, res) => {
    const { userId } = req.query;

    try {
        // 로그인 유저가 있으면 만료 처리 먼저 실행
        if (userId) {
            await processExpiredMatches(userId);
        }

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

// 4-2. 매칭 신청 (선불제: A가 신청 시 매칭권 즉시 차감)
app.post('/api/matches', async (req, res) => {
    const { from_user_id, to_card_id, type } = req.body;

    if (!from_user_id || !to_card_id) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // 1. 대상 카드의 타입 확인
        const { data: targetCard } = await supabase
            .from('profiles')
            .select('id, type, user_id')
            .eq('id', to_card_id)
            .single();

        if (!targetCard) {
            return res.status(404).json({ error: '대상 카드를 찾을 수 없습니다.' });
        }

        // 2. 매칭권 비용 계산
        const cost = calculateTicketCost(targetCard.type, type);

        // 3. A의 매칭권 확인
        const { data: fromUser } = await supabase
            .from('users')
            .select('free_tickets, nickname')
            .eq('id', from_user_id)
            .single();

        if (!fromUser) {
            return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
        }

        const currentTickets = fromUser.free_tickets || 0;
        if (currentTickets < cost.a) {
            return res.status(400).json({ 
                error: `매칭권이 부족합니다. (필요: ${cost.a}장, 보유: ${currentTickets}장)`,
                needed: cost.a,
                owned: currentTickets
            });
        }

        // 4. 이미 신청한 매칭인지 확인 (pending 상태)
        const { data: existing } = await supabase
            .from('matches')
            .select('id')
            .eq('from_user_id', from_user_id)
            .eq('to_card_id', to_card_id)
            .eq('status', 'pending')
            .limit(1);

        if (existing && existing.length > 0) {
            return res.status(400).json({ error: '이미 신청한 매칭입니다.' });
        }

        // 5. A의 매칭권 즉시 차감
        await supabase
            .from('users')
            .update({ free_tickets: currentTickets - cost.a })
            .eq('id', from_user_id);

        // 6. 매칭 저장 (3일 만료)
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 3);

        const { data, error } = await supabase
            .from('matches')
            .insert([{
                from_user_id,
                to_card_id,
                type: type || 'normal',
                status: 'pending',
                a_tickets_used: cost.a,
                b_tickets_used: 0,
                expires_at: expiresAt.toISOString()
            }])
            .select();

        if (error) throw error;

        // 7. 알림 발송 (B에게)
        if (targetCard.user_id) {
            await supabase.from('notifications').insert([{
                user_id: targetCard.user_id,
                type: 'match_request',
                title: '💌 새 매칭 신청이 도착했어요!',
                message: `${fromUser.nickname || '누군가'}님이 매칭을 신청했어요. 3일 내에 응답해주세요!`,
                link: 'matching',
                is_read: false
            }]);
        }

        res.status(201).json({ 
            success: true, 
            match: data[0],
            tickets_used: cost.a,
            tickets_remaining: currentTickets - cost.a
        });
    } catch (err) {
        console.error('Match create error:', err);
        res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
    }
});

// 4-3. 매칭 응답 (수락/거절) - 선불제
app.put('/api/matches/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: '유효한 상태가 아닙니다.' });
    }

    try {
        // 1. 매칭 정보 조회
        const { data: match, error: fetchError } = await supabase
            .from('matches')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !match) {
            return res.status(404).json({ error: '매칭을 찾을 수 없습니다.' });
        }

        if (match.status !== 'pending') {
            return res.status(400).json({ error: '이미 처리된 매칭입니다.' });
        }

        // 2. 대상 카드 타입 확인
        const { data: targetCard } = await supabase
            .from('profiles')
            .select('id, type, user_id')
            .eq('id', match.to_card_id)
            .single();

        const cardType = targetCard?.type || 'solo';
        const cost = calculateTicketCost(cardType, match.type);

        // ===== 거절 처리 =====
        if (status === 'rejected') {
            // A 매칭권 환급
            if (match.a_tickets_used > 0) {
                const { data: fromUser } = await supabase
                    .from('users')
                    .select('free_tickets')
                    .eq('id', match.from_user_id)
                    .single();

                if (fromUser) {
                    await supabase
                        .from('users')
                        .update({ free_tickets: (fromUser.free_tickets || 0) + match.a_tickets_used })
                        .eq('id', match.from_user_id);
                }
            }

            await supabase
                .from('matches')
                .update({ status: 'rejected', responded_at: new Date().toISOString() })
                .eq('id', id);

            // A에게 알림
            await supabase.from('notifications').insert([{
                user_id: match.from_user_id,
                type: 'match_rejected',
                title: '💔 매칭이 거절되었습니다.',
                message: `상대방이 매칭을 거절했어요. 사용했던 매칭권 ${match.a_tickets_used}장이 환급되었어요.`,
                link: 'matching',
                is_read: false
            }]);

            return res.json({ success: true, action: 'rejected', refunded: match.a_tickets_used });
        }

        // ===== 수락 처리 =====
        // B의 매칭권 확인 (필요한 경우만)
        if (cost.b > 0) {
            const { data: toUser } = await supabase
                .from('users')
                .select('free_tickets')
                .eq('id', targetCard.user_id)
                .single();

            const toUserTickets = toUser?.free_tickets || 0;
            if (toUserTickets < cost.b) {
                return res.status(400).json({ 
                    error: `매칭권이 부족합니다. (필요: ${cost.b}장, 보유: ${toUserTickets}장)`,
                    needed: cost.b,
                    owned: toUserTickets
                });
            }

            // B 매칭권 차감
            await supabase
                .from('users')
                .update({ free_tickets: toUserTickets - cost.b })
                .eq('id', targetCard.user_id);
        }

        // 매칭 성사
        await supabase
            .from('matches')
            .update({ 
                status: 'accepted', 
                responded_at: new Date().toISOString(),
                b_tickets_used: cost.b
            })
            .eq('id', id);

        // A에게 알림
        await supabase.from('notifications').insert([{
            user_id: match.from_user_id,
            type: 'match_accepted',
            title: '💌 매칭이 수락되었습니다!',
            message: '상대방이 매칭을 수락했어요. 연락처를 확인해보세요!',
            link: 'matching',
            is_read: false
        }]);

        res.json({ success: true, action: 'accepted', b_tickets_used: cost.b });
    } catch (err) {
        console.error('Match update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4-4. 매칭 신청 취소 (A가 pending 매칭 취소 → 환급)
app.delete('/api/matches/:id', async (req, res) => {
    const { id } = req.params;
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { data: match, error: fetchError } = await supabase
            .from('matches')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !match) {
            return res.status(404).json({ error: '매칭을 찾을 수 없습니다.' });
        }

        // 본인의 매칭인지 확인
        if (String(match.from_user_id) !== String(userId)) {
            return res.status(403).json({ error: '본인의 매칭만 취소할 수 있습니다.' });
        }

        if (match.status !== 'pending') {
            return res.status(400).json({ error: '대기 중인 매칭만 취소할 수 있습니다.' });
        }

        // A 매칭권 환급
        if (match.a_tickets_used > 0) {
            const { data: fromUser } = await supabase
                .from('users')
                .select('free_tickets')
                .eq('id', match.from_user_id)
                .single();

            if (fromUser) {
                await supabase
                    .from('users')
                    .update({ free_tickets: (fromUser.free_tickets || 0) + match.a_tickets_used })
                    .eq('id', match.from_user_id);
            }
        }

        // 매칭 취소 처리
        await supabase
            .from('matches')
            .update({ status: 'cancelled', responded_at: new Date().toISOString() })
            .eq('id', id);

        res.json({ success: true, refunded: match.a_tickets_used });
    } catch (err) {
        console.error('Match cancel error:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4-5. 사용 중인 매칭권 개수 조회 (pending 상태인 A의 매칭권 합계)
app.get('/api/matches/in-use-tickets', async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('matches')
            .select('a_tickets_used')
            .eq('from_user_id', userId)
            .eq('status', 'pending');

        if (error) throw error;

        const inUse = (data || []).reduce((sum, m) => sum + (m.a_tickets_used || 0), 0);
        res.json({ in_use: inUse });
    } catch (err) {
        console.error('In-use tickets error:', err);
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

// 6. 알림 개별 삭제
app.delete('/api/notifications/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 7. 알림 전체 삭제 (사용자의 모든 알림)
app.post('/api/notifications/delete-all', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }
    try {
        const { error } = await supabase
            .from('notifications')
            .delete()
            .eq('user_id', userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Delete all notifications error:', error);
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
//  차단 관련 API
// ============================================================

// 1. 차단하기 (주간 3명 제한 + 차단사유 + 매칭 자동 취소)
app.post('/api/blocks', async (req, res) => {
    const { blocker_user_id, blocked_user_id, reason } = req.body;

    if (!blocker_user_id || !blocked_user_id) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }
    if (String(blocker_user_id) === String(blocked_user_id)) {
        return res.status(400).json({ error: '본인을 차단할 수 없습니다.' });
    }

    try {
        // 1. 이미 차단한 유저인지 확인
        const { data: existing } = await supabase
            .from('blocks')
            .select('id')
            .eq('blocker_user_id', blocker_user_id)
            .eq('blocked_user_id', blocked_user_id)
            .limit(1);

        if (existing && existing.length > 0) {
            return res.status(400).json({ error: '이미 차단한 유저입니다.' });
        }

        // 2. 주간 차단 횟수 확인 (최근 7일)
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const { data: weeklyBlocks } = await supabase
            .from('blocks')
            .select('id')
            .eq('blocker_user_id', blocker_user_id)
            .gte('created_at', weekAgo.toISOString());

        const weeklyCount = weeklyBlocks?.length || 0;
        if (weeklyCount >= 3) {
            return res.status(400).json({
                error: '일주일에 최대 3명까지만 차단할 수 있습니다.',
                weeklyCount: weeklyCount
            });
        }

        // 3. 차단 저장
        const { data, error } = await supabase
            .from('blocks')
            .insert([{
                blocker_user_id,
                blocked_user_id,
                reason: reason || null
            }])
            .select();

        if (error) throw error;

        // ============================================================
        // 4. 매칭 자동 취소 (pending 상태만)
        // ============================================================
        try {
            // 두 유저의 카드 ID 조회
            const { data: blockerCards } = await supabase
                .from('profiles')
                .select('id')
                .eq('user_id', blocker_user_id);

            const { data: blockedCards } = await supabase
                .from('profiles')
                .select('id')
                .eq('user_id', blocked_user_id);

            const blockerCardIds = (blockerCards || []).map(c => c.id);
            const blockedCardIds = (blockedCards || []).map(c => c.id);
            const allCardIds = [...blockerCardIds, ...blockedCardIds];

            if (allCardIds.length > 0) {
                // 양방향 pending 매칭 조회
                const { data: pendingMatches } = await supabase
                    .from('matches')
                    .select('*')
                    .eq('status', 'pending')
                    .or(`from_user_id.eq.${blocker_user_id},from_user_id.eq.${blocked_user_id}`)
                    .in('to_card_id', allCardIds);

                if (pendingMatches && pendingMatches.length > 0) {
                    for (const match of pendingMatches) {
                        // A의 매칭권 환급
                        if (match.a_tickets_used > 0) {
                            const { data: fromUser } = await supabase
                                .from('users')
                                .select('free_tickets')
                                .eq('id', match.from_user_id)
                                .single();

                            if (fromUser) {
                                await supabase
                                    .from('users')
                                    .update({ free_tickets: (fromUser.free_tickets || 0) + match.a_tickets_used })
                                    .eq('id', match.from_user_id);
                            }
                        }

                        // 매칭 취소
                        await supabase
                            .from('matches')
                            .update({ status: 'cancelled', responded_at: new Date().toISOString() })
                            .eq('id', match.id);

                        // A에게 알림
                        await supabase.from('notifications').insert([{
                            user_id: match.from_user_id,
                            type: 'match_cancelled',
                            title: '🚫 차단으로 인한 매칭 취소',
                            message: `차단으로 인해 매칭이 자동 취소되었어요. 사용한 매칭권 ${match.a_tickets_used}장이 환급되었어요.`,
                            link: 'matching',
                            is_read: false
                        }]);

                        console.log(`🚫 차단으로 매칭 ${match.id} 자동 취소 (A 환급: ${match.a_tickets_used}장)`);
                    }
                }
            }
        } catch (cancelError) {
            // 매칭 취소 실패해도 차단은 성공 처리
            console.error('매칭 자동 취소 오류:', cancelError);
        }

        res.status(201).json({
            success: true,
            block: data[0],
            remaining: 2 - weeklyCount
        });
    } catch (error) {
        console.error('Block error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 내가 차단한 유저 목록 조회
app.get('/api/blocks', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('blocks')
            .select(`
                id,
                reason,
                created_at,
                blocked_user:blocked_user_id(id, nickname, school, major, grade, gender, age, animal)
            `)
            .eq('blocker_user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error('Blocks fetch error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. 주간 차단 횟수 조회
app.get('/api/blocks/weekly-count', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const { data, error } = await supabase
            .from('blocks')
            .select('id')
            .eq('blocker_user_id', userId)
            .gte('created_at', weekAgo.toISOString());

        if (error) throw error;

        const count = data?.length || 0;
        res.json({ count, remaining: Math.max(0, 3 - count) });
    } catch (error) {
        console.error('Weekly count error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3-2. 나와 관련된 모든 차단 유저 ID (양방향)
// - 내가 차단한 사람 + 나를 차단한 사람
app.get('/api/blocks/related-user-ids', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        // 내가 차단한 사람
        const { data: iBlocked } = await supabase
            .from('blocks')
            .select('blocked_user_id')
            .eq('blocker_user_id', userId);

        // 나를 차단한 사람
        const { data: blockedMe } = await supabase
            .from('blocks')
            .select('blocker_user_id')
            .eq('blocked_user_id', userId);

        const ids = new Set();
        (iBlocked || []).forEach(b => ids.add(String(b.blocked_user_id)));
        (blockedMe || []).forEach(b => ids.add(String(b.blocker_user_id)));

        res.json({ user_ids: Array.from(ids) });
    } catch (error) {
        console.error('Related block IDs error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. 차단 해제
app.delete('/api/blocks/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('blocks')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error('Unblock error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//  관리자: 카드 직접 삭제 API
// ============================================================

app.post('/api/admin/delete-card', async (req, res) => {
    const { admin_user_id, card_id, reason } = req.body;

    if (!admin_user_id || !card_id || !reason) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // 1. 관리자 검증
        const { data: adminUser } = await supabase
            .from('users')
            .select('id, is_admin, nickname')
            .eq('id', admin_user_id)
            .single();

        if (!adminUser || !adminUser.is_admin) {
            return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
        }

        // 2. 카드 정보 조회
        const { data: card } = await supabase
            .from('profiles')
            .select('id, user_id, type, school, major, age, gender, emoji')
            .eq('id', card_id)
            .single();

        if (!card) {
            return res.status(404).json({ error: '카드를 찾을 수 없습니다.' });
        }

        // 3. 카드 소유자 정보
        const { data: owner } = await supabase
            .from('users')
            .select('id, nickname')
            .eq('id', card.user_id)
            .single();

        const typeLabel = card.type === 'solo' ? '둘이서 (1:1)' :
                         card.type === 'group' ? '여럿이서 (다대다)' :
                         card.type === 'same' ? '동성친구 찾기' : '카드';

        // 4. 관련 데이터 정리
        // 4-1. 좋아요 삭제
        await supabase.from('likes').delete().eq('card_id', card_id);

        // 4-2. pending 매칭 삭제 (A 환급 처리)
        const { data: pendingMatches } = await supabase
            .from('matches')
            .select('*')
            .eq('to_card_id', card_id)
            .eq('status', 'pending');

        if (pendingMatches && pendingMatches.length > 0) {
            for (const match of pendingMatches) {
                // A의 매칭권 환급
                if (match.a_tickets_used > 0) {
                    const { data: fromUser } = await supabase
                        .from('users')
                        .select('free_tickets')
                        .eq('id', match.from_user_id)
                        .single();

                    if (fromUser) {
                        await supabase
                            .from('users')
                            .update({ free_tickets: (fromUser.free_tickets || 0) + match.a_tickets_used })
                            .eq('id', match.from_user_id);
                    }
                }

                await supabase
                    .from('matches')
                    .update({ status: 'cancelled', responded_at: new Date().toISOString() })
                    .eq('id', match.id);

                // A에게 알림
                await supabase.from('notifications').insert([{
                    user_id: match.from_user_id,
                    type: 'match_cancelled',
                    title: '🚫 매칭이 취소되었어요',
                    message: `관리자에 의해 대상 카드가 삭제되어 매칭이 취소되었어요. 사용한 매칭권 ${match.a_tickets_used}장이 환급되었어요.`,
                    link: 'matching',
                    is_read: false
                }]);
            }
        }

        // 5. 카드 삭제
        const { error: deleteError } = await supabase
            .from('profiles')
            .delete()
            .eq('id', card_id);

        if (deleteError) throw deleteError;

        // 6. 삭제 로그 저장 (선택)
        try {
            await supabase.from('admin_card_deletions').insert([{
                admin_user_id,
                target_user_id: card.user_id,
                card_id,
                card_type: card.type,
                reason: reason
            }]);
        } catch (logErr) {
            console.warn('삭제 로그 저장 실패 (무시):', logErr);
        }

        // 7. 카드 소유자에게 알림
        await supabase.from('notifications').insert([{
            user_id: card.user_id,
            type: 'card_deleted_by_admin',
            title: '🚫 관리자에 의해 카드가 삭제되었습니다.',
            message: `회원님의 "${typeLabel}" 카드가 관리자에 의해 삭제되었어요. 삭제사유: ${reason}`,
            link: 'mypage',
            is_read: false
        }]);

        console.log(`🗑️ 관리자(${adminUser.nickname})가 카드 ${card_id} 삭제 (사유: ${reason})`);

        res.json({ 
            success: true, 
            deleted_card_id: card_id,
            owner_nickname: owner?.nickname || '알 수 없음'
        });

    } catch (error) {
        console.error('Admin delete card error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
//  매칭 후기 관련 API
// ============================================================

// 1. 후기 작성
app.post('/api/reviews', async (req, res) => {
    const { user_id, match_id, target_user_id, card_type, target_school, target_major, content } = req.body;

    if (!user_id || !content) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }
    if (content.trim().length < 30) {
        return res.status(400).json({ error: '후기는 최소 30자 이상 작성해주세요.' });
    }

    try {
        // ★★★ 이미 '검수 중(pending)' 또는 '승인(approved)'된 후기가 있는지만 확인 ★★★
        // 반려(rejected)된 후기는 재작성 가능!
        if (match_id) {
            const { data: existing } = await supabase
                .from('reviews')
                .select('id, status')
                .eq('user_id', user_id)
                .eq('match_id', match_id)
                .in('status', ['pending', 'approved'])
                .limit(1);

            if (existing && existing.length > 0) {
                const status = existing[0].status;
                const msg = status === 'pending' 
                    ? '이미 검수 중인 후기가 있습니다.' 
                    : '이미 승인된 후기가 있습니다.';
                return res.status(400).json({ error: msg });
            }
        }

        const { data, error } = await supabase
            .from('reviews')
            .insert([{
                user_id,
                match_id: match_id || null,
                target_user_id: target_user_id || null,
                card_type: card_type || 'solo',
                target_school: target_school || null,
                target_major: target_major || null,
                content: content.trim(),
                status: 'pending'
            }])
            .select();

        if (error) throw error;
        res.status(201).json(data[0]);
    } catch (error) {
        console.error('Review create error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. 내가 쓴 후기 목록
app.get('/api/reviews/my', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ error: '사용자 ID가 필요합니다.' });
    }

    try {
        const { data, error } = await supabase
            .from('reviews')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('My reviews error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. 특정 매칭에 후기를 썼는지 확인 (pending/approved만)
app.get('/api/reviews/check', async (req, res) => {
    const { userId, matchId } = req.query;
    if (!userId || !matchId) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    try {
        // pending 또는 approved 상태의 후기만 확인
        const { data, error } = await supabase
            .from('reviews')
            .select('id, status, content, created_at')
            .eq('user_id', userId)
            .eq('match_id', matchId)
            .in('status', ['pending', 'approved'])
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) throw error;
        
        // 반려된 후기도 함께 조회 (재작성 시 참고용)
        const { data: rejected } = await supabase
            .from('reviews')
            .select('id, status, content, reject_reason, created_at')
            .eq('user_id', userId)
            .eq('match_id', matchId)
            .eq('status', 'rejected')
            .order('created_at', { ascending: false })
            .limit(1);

        res.json({ 
            exists: data && data.length > 0, 
            review: data?.[0] || null,
            rejectedReview: rejected?.[0] || null
        });
    } catch (error) {
        console.error('Review check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. 관리자: 후기 목록 (상태별 필터 가능)
app.get('/api/admin/reviews', async (req, res) => {
    const { status } = req.query; // 'pending', 'approved', 'rejected', 'all'

    try {
        let query = supabase
            .from('reviews')
            .select(`
                *,
                user:user_id(nickname, school, grade, animal, gender)
            `)
            .order('created_at', { ascending: false });

        if (status && status !== 'all') {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json(data || []);
    } catch (error) {
        console.error('Admin reviews error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. 관리자: 후기 승인 (매칭권 지급)
app.put('/api/admin/reviews/:id/approve', async (req, res) => {
    const { id } = req.params;

    try {
        // 1. 후기 정보 조회
        const { data: review, error: fetchError } = await supabase
            .from('reviews')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !review) {
            return res.status(404).json({ error: '후기를 찾을 수 없습니다.' });
        }

        if (review.status === 'approved') {
            return res.status(400).json({ error: '이미 승인된 후기입니다.' });
        }

        // 2. 매칭권 개수 계산 (30자 이상 1개, 100자 이상 2개)
        const contentLength = review.content.length;
        const rewardTickets = contentLength >= 100 ? 2 : 1;

        // 3. 후기 상태 업데이트
        const { error: updateError } = await supabase
            .from('reviews')
            .update({
                status: 'approved',
                reward_tickets: rewardTickets,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) throw updateError;

        // 4. 유저 매칭권 지급
        const { data: userData } = await supabase
            .from('users')
            .select('free_tickets')
            .eq('id', review.user_id)
            .single();

        if (userData) {
            await supabase
                .from('users')
                .update({ free_tickets: (userData.free_tickets || 0) + rewardTickets })
                .eq('id', review.user_id);
        }

        // 5. 알림 발송
        const typeLabel = review.card_type === 'solo' ? '둘이서' :
                         review.card_type === 'group' ? '여럿이서' :
                         review.card_type === 'same' ? '동성친구' : '매칭';
        const targetInfo = `${review.target_school || ''} ${review.target_major || ''}`.trim() || '상대방';

        await supabase.from('notifications').insert([{
            user_id: review.user_id,
            type: 'review_approved',
            title: '✅ 매칭 후기가 승인되었습니다!',
            message: `(${typeLabel}) ${targetInfo}과의 매칭 후기가 승인되었어요. 매칭권 ${rewardTickets}개가 지급되었어요!`,
            link: 'mypage',
            is_read: false
        }]);

        res.json({ success: true, reward_tickets: rewardTickets });
    } catch (error) {
        console.error('Review approve error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. 관리자: 후기 반려
app.put('/api/admin/reviews/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
        return res.status(400).json({ error: '반려 사유가 필요합니다.' });
    }

    try {
        const { data: review, error: fetchError } = await supabase
            .from('reviews')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError || !review) {
            return res.status(404).json({ error: '후기를 찾을 수 없습니다.' });
        }

        const { error: updateError } = await supabase
            .from('reviews')
            .update({
                status: 'rejected',
                reject_reason: reason,
                reviewed_at: new Date().toISOString()
            })
            .eq('id', id);

        if (updateError) throw updateError;

        // ===== ★ 매칭 상대 카드 ID 찾기 (card_type 필터 적용) ★ =====
        let targetCardId = null;
        if (review.match_id) {
            const { data: matchData } = await supabase
                .from('matches')
                .select('*')
                .eq('id', review.match_id)
                .single();

            if (matchData) {
                if (String(matchData.from_user_id) === String(review.user_id)) {
                    // 내가 신청자 → to_card_id가 상대 카드
                    targetCardId = matchData.to_card_id;
                } else {
                    // 내가 수락자 → 상대(from_user)의 카드 중 같은 type 찾기
                    const { data: fromCards } = await supabase
                        .from('profiles')
                        .select('id')
                        .eq('user_id', matchData.from_user_id)
                        .eq('type', review.card_type)
                        .limit(1);
                    targetCardId = fromCards?.[0]?.id || null;

                    // 위에서 못 찾으면 type 무관하게 하나 가져오기 (fallback)
                    if (!targetCardId) {
                        const { data: anyCard } = await supabase
                            .from('profiles')
                            .select('id')
                            .eq('user_id', matchData.from_user_id)
                            .limit(1);
                        targetCardId = anyCard?.[0]?.id || null;
                    }
                }
            }
        }

        const typeLabel = review.card_type === 'solo' ? '둘이서' :
                         review.card_type === 'group' ? '여럿이서' :
                         review.card_type === 'same' ? '동성친구' : '매칭';
        const targetInfo = `${review.target_school || ''} ${review.target_major || ''}`.trim() || '상대방';

        // ===== ★ 알림 생성 (match_id도 함께 저장!) ★ =====
        await supabase.from('notifications').insert([{
            user_id: review.user_id,
            type: 'review_rejected',
            title: '❌ 매칭 후기가 반려되었습니다.',
            message: `(${typeLabel}) ${targetInfo}과의 매칭 후기가 반려되었어요. 반려 사유: ${reason}. 좀 더 진정성 있는 후기를 남겨 주세요.`,
            link: null,
            card_id: targetCardId,
            match_id: review.match_id || null,
            is_read: false
        }]);

        res.json({ success: true });
    } catch (error) {
        console.error('Review reject error:', error);
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