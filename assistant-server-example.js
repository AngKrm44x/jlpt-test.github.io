import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const client = new OpenAI({
  baseURL: 'https://router.bynara.id/v1',
  apiKey: sk-nry-BbwEFYuHIrwpgvZuyGRmsQ1X-3fqZriVfmIoQNSMFOw,
});

const SYSTEM_PROMPT = 'Kamu adalah AI Assistant untuk website belajar Jepang. Fokus utama: JLPT, JFT-Basic, JLCT, SSW/Tokutei Ginou, NAT-Test, J.Test, EJU, dan ujian Jepang lain yang relevan. Jawab dalam bahasa Indonesia yang mudah dipahami, boleh mencampur istilah Jepang bila membantu. Berikan jawaban singkat, jelas, dan praktis. Jika di luar topik, arahkan kembali dengan sopan.';

app.post('/api/assistant', async (req, res) => {
  try {
    const { messages = [], model = 'deepseek-3.2' } = req.body || {};

    const chatMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.filter(m => m && typeof m.content === 'string').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: m.content,
      })),
    ];

    const completion = await client.chat.completions.create({
      model,
      messages: chatMessages,
    });

    const answer = completion?.choices?.[0]?.message?.content || 'Maaf, respons AI belum tersedia.';
    res.json({ choices: [{ message: { content: answer } }] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Assistant request failed' });
  }
});

app.listen(3000, () => console.log('Assistant server running on http://localhost:3000'));
