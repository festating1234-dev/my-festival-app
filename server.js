const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(cors());
app.use(express.json());

// 정적 파일 제공 (index.html이 있는 폴더)
app.use(express.static(path.join(__dirname)));

// 테스트용 API (서버가 살아있는지 확인)
app.get('/api/test', (req, res) => {
    res.json({ message: '서버가 정상 실행 중입니다! 🎉' });
});

// 모든 요청을 index.html로 보내기 (SPA 지원)
app.get('/*splat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 서버 시작
app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중! http://localhost:${PORT} 에 접속하세요.`);
});