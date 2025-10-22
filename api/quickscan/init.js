import OpenAI from "openai";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { contact, focus, context } = req.body || {};
    if (!contact?.email || !focus) {
      return res.status(400).json({ error: "email und focus sind Pflicht" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt = `
Du bist Operations-Analyst in der Fertigung. Fokus: "${focus}".
Erzeuge GENAU 6 Reibungspunkte (Zellen) mit diesen festen IDs:
1) auftragsstart (Anforderungen & Auftragsstart)
2) ressourcen (Ressourcenverfügbarkeit)
3) uebergabe (Übergaben & Kommunikation)
4) problem (Problemmanagement)
5) priorisierung (Priorisierung & (Fein-)Planung)
6) verantwortung (Verantwortlichkeiten & Entscheidungen)

Für JEDE Zelle:
- "diagnostic_question": prägnante Frage
- "options": GENAU 4 Antwort-Optionen (Texte), die klar 3 / 2 / 1 / 0 entsprechen.
  3 = stabil, 2 = meist okay, 1 = wacklig, 0 = kritisch.
- Jede Option hat { id, label, score_value } – score_value MUSS eine der Zahlen 3,2,1,0 sein.

Schreibe knapp, konkret, ohne Floskeln, deutsch. Gib AUSSCHLIESSLICH JSON im Schema:

{
  "cells":[
    {
      "id":"auftragsstart",
      "name":"Anforderungen & Auftragsstart",
      "diagnostic_question":"...",
      "options":[
        {"id":"...","label":"...","score_value":3},
        {"id":"...","label":"...","score_value":2},
        {"id":"...","label":"...","score_value":1},
        {"id":"...","label":"...","score_value":0}
      ]
    },
    ...
  ]
}
        `.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "Antworte ausschließlich mit gültigem JSON. Keine Erklärungen." },
        { role: "user", content: prompt }
      ]
    });

    let text = completion.choices?.[0]?.message?.content?.trim() || "{}";
    text = text.replace(/^```json\\s*/i, "").replace(/```$/,"");
    const data = JSON.parse(text);

    return res.status(200).json({
      contact,
      focus,
      cells: data.cells
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "KI-Fehler", detail: String(err?.message || err) });
  }
}
