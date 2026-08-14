const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { Groq } = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && process.env.FIREBASE_SERVICE_ACCOUNT_PATH.trim() !== '') {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    credential = cert(serviceAccount);
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    credential = cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
  } else {
    // Fallback to local hardcoded JSON if everything else is missing (for safety)
    credential = cert(require('./taskhub-65bd5-firebase-adminsdk-fbsvc-e84388d8ba.json'));
  }

  initializeApp({
    credential: credential,
    databaseURL: process.env.DATABASE_URL || "https://taskhub-65bd5-default-rtdb.firebaseio.com"
  });
  console.log('Firebase Admin initialized successfully.');
} catch (error) {
  console.error('Error initializing Firebase Admin:', error);
}

const db = getDatabase();

// Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================================
// GROQ AI ENDPOINT
// ==========================================
app.post('/api/ai/check-translations', async (req, res) => {
  try {
    const { translations } = req.body;
    // translations is an array of objects: { original: 'Tiếng Việt', translated: 'Tiếng Nhật của user' }
    
    if (!translations || !Array.isArray(translations)) {
      return res.status(400).json({ error: 'Invalid translations format' });
    }

    const promptText = `
Bạn là một giáo viên tiếng Nhật. Nhiệm vụ của bạn là kiểm tra các câu dịch từ tiếng Việt sang tiếng Nhật của học sinh.
Dưới đây là danh sách các câu học sinh đã dịch. Hãy chỉ ra lỗi sai (nếu có), giải thích ngắn gọn, và đưa ra câu gợi ý tốt nhất.
Trả về kết quả dưới định dạng JSON là một mảng, mỗi phần tử tương ứng với một câu trong mảng đầu vào, cấu trúc như sau:
[
  {
    "isCorrect": boolean,
    "feedback": "Nhận xét và giải thích lỗi sai",
    "suggestedTranslation": "Câu dịch đúng"
  }
]

Dữ liệu của học sinh:
${JSON.stringify(translations, null, 2)}
    `.trim();

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "You are a helpful Japanese teacher. You must output ONLY valid JSON format as requested, without markdown blocks."
        },
        {
          role: "user",
          content: promptText
        }
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });

    let content = completion.choices[0].message?.content || "[]";
    let result = [];
    try {
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        result = JSON.parse(match[0]);
      } else {
        result = JSON.parse(content);
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', content);
      return res.status(500).json({ error: 'AI returned invalid data format' });
    }

    res.json({ result });
  } catch (error) {
    console.error('Error with Groq API:', error.message || error);
    res.status(500).json({ error: 'Failed to process AI check' });
  }
});

app.post('/api/ai/generate-sentences', async (req, res) => {
  try {
    const { vocabs, grammars } = req.body;
    
    if ((!vocabs || vocabs.length === 0) && (!grammars || grammars.length === 0)) {
      return res.status(400).json({ error: 'Please provide at least one vocabulary or grammar.' });
    }

    const promptText = `
Bạn là một chuyên gia ngôn ngữ và giáo viên tiếng Nhật cao cấp. Nhiệm vụ của bạn là tạo ra các câu tiếng Việt để học sinh luyện dịch sang tiếng Nhật.
Yêu cầu QUAN TRỌNG VỀ CHẤT LƯỢNG:
1. Các câu tiếng Việt phải có "chiều sâu" ngữ nghĩa, ngữ cảnh rõ ràng (ví dụ: giao tiếp công sở, đời sống hàng ngày, văn phong lịch sự hoặc xuồng xã). Không tạo các câu quá ngắn, nhàm chán hay ngô nghê.
2. Bạn phải tính toán trước rằng khi học sinh dịch câu tiếng Việt này sang tiếng Nhật, kết quả thu được phải là cách diễn đạt TỰ NHIÊN, PHỔ THÔNG và ĐÚNG VĂN PHONG của người bản xứ Nhật Bản, KHÔNG được dịch word-by-word một cách gượng ép.
3. Với mỗi từ vựng được cung cấp, hãy tạo ra đúng 3 câu tiếng Việt (để khi dịch sang tiếng Nhật bắt buộc phải dùng từ vựng đó). Trong 3 câu này, bắt buộc phải có 1 câu ở mức độ KHÓ (câu dài, phức tạp hoặc trừu tượng), 2 câu còn lại ở mức độ BÌNH THƯỜNG.
4. Với mỗi ngữ pháp được cung cấp, hãy tạo ra đúng 5 câu tiếng Việt (để khi dịch sang tiếng Nhật bắt buộc phải dùng ngữ pháp đó). Trong 5 câu này, bắt buộc phải có 1-2 câu ở mức độ KHÓ, còn lại ở mức độ BÌNH THƯỜNG.
5. Khi xây dựng các câu hỏi (đặc biệt là câu khó), hãy ưu tiên kết hợp thêm các từ vựng và ngữ pháp ở trình độ N3 - N2 để tăng tính thử thách cho học sinh.
6. Tổng hợp TẤT CẢ các câu đã tạo vào MỘT mảng duy nhất gồm các chuỗi (string).

Dữ liệu đầu vào:
- Từ vựng: ${JSON.stringify(vocabs)}
- Ngữ pháp: ${JSON.stringify(grammars)}

Trả về kết quả dưới định dạng JSON là một mảng các chuỗi, ví dụ:
[
  "Hôm qua, vì trời mưa rất to nên chuyến tàu điện ngầm mà tôi định đi đã bị trễ mất 30 phút.",
  "Trong môi trường công sở ở Nhật, việc chào hỏi cấp trên một cách to tát và rõ ràng là một nét văn hóa vô cùng quan trọng."
]
    `.trim();

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "You are a helpful Japanese teacher. You must output ONLY a valid JSON array of strings, without any markdown blocks or other text."
        },
        {
          role: "user",
          content: promptText
        }
      ],
      temperature: 0.7,
      max_tokens: 2048,
    });

    let content = completion.choices[0].message?.content || "[]";
    let result = [];
    try {
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        result = JSON.parse(match[0]);
      } else {
        result = JSON.parse(content);
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', content);
      return res.status(500).json({ error: 'AI returned invalid data format' });
    }

    res.json({ result });
  } catch (error) {
    console.error('Error generating sentences:', error.message || error);
    res.status(500).json({ error: 'Failed to generate sentences' });
  }
});


// ==========================================
// CRUD ENDPOINTS (Vocabulary & Grammar)
// ==========================================

// Helper to get database reference based on type (vocab, grammar, exercise)
const getCollection = (type) => {
  if (type === 'grammar') return db.ref('grammars');
  if (type === 'exercise') return db.ref('exercises');
  return db.ref('vocabularies');
};

// GET all items
app.get('/api/items/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const snapshot = await getCollection(type).once('value');
    const items = [];
    snapshot.forEach(childSnapshot => {
      items.push({ id: childSnapshot.key, ...childSnapshot.val() });
    });
    res.json(items);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// POST new item
app.post('/api/items/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const data = req.body;
    
    // Set initial SRS data only for vocab and grammar
    if (type !== 'exercise') {
      data.interval = 1; 
      data.nextReviewDate = new Date().toISOString();
      data.inReviewCycle = true;
    }
    
    const newRef = getCollection(type).push();
    await newRef.set(data);
    res.json({ id: newRef.key, ...data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT update item (general edit or SRS update)
app.put('/api/items/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const data = req.body;
    await getCollection(type).child(id).update(data);
    res.json({ id, ...data });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE item
app.delete('/api/items/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    await getCollection(type).child(id).remove();
    res.json({ success: true, id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
