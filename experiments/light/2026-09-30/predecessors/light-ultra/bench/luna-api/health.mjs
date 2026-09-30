// Health requests use the same direct observation and durable admission hook.
const response = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, max_output_tokens: 128, input: 'Reply OK.', stream: false, store: false }),
});
console.log(JSON.stringify({ health_status: response.status }));
if (!response.ok) process.exitCode = 1;
