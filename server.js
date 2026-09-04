const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // index.html이 있는 폴더를 공개

// 아직 DB는 없지만, 일단 서버가 실행되는지 테스트용
app.get('/api/test', (req, res) => {
  res.json({ message: '서버가 정상 실행 중입니다! 🎉' });
});

// 모든 요청을 index.html로 보내기 (페이지 이동 처리)
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중! http://localhost:${PORT} 에 접속하세요.`);
});