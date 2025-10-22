import OpenAI from "openai";
import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

function ampelfarbe(x) {
  if (x < 1.0) return "🔴 kritisch";
  if (x < 2.0) return "🟠 schwankend";
  return "🟢 stabil";
}

function calcKultur(scores) {
  const K = 0.4*scores.priorisierung + 0.4*scores.verantwortung + 0.2*scores.auftragsstart;
  const U = 0.5*scores.uebergabe + 0.25*scores.auftragsstart + 0.25*scores.problem;
  const L = 0.6*scores.problem + 0.2*scores.uebergabe + 0.2*scores.verantwortung;
  const T = 0.5*scores.priorisierung + 0.25*scores.uebergabe + 0.25*scores.ressourcen;
  const U2= 0.7*scores.ressourcen + 0.3*scores.auftragsstart; // Umfeld
  const R = 0.5*scores.verantwortung + 0.3*scores.problem + 0.2*scores.priorisierung;
  return { K, U, L, T, U_umfeld: U2, R };
}

function worstCells(scores) {
  const arr = Object.entries(scores).map(([k,v]) => ({ id:k, score:v }));
  arr.sort((a,b)=>a.score-b.score);
  const worst = [arr[0]];
  if (arr[1].score - arr[0].score <= 0.2) worst.push(arr[1]);
  return worst;
}

function makePdfBuffer({ company, focus, contact, cells, selections, cellScores, kultur, decisions, experiments }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text("QuickScan – Ergebnis", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11).text(`Firma: ${company || "-"}`);
    doc.text(`Kontakt: ${contact?.name || "-"} <${contact?.email || "-"}>`);
    doc.text(`Fokus: ${focus}`);
    doc.moveDown();

    doc.fontSize(14).text("Ihre Auswahl (0–3 als Text abgebildet):");
    doc.moveDown(0.3);
    cells.forEach((c) => {
      const pick = selections.find(s=>s.cell_id===c.id);
      const label = c.options.find(o=>o.id===pick?.selected_option_id)?.label || "-";
      doc.fontSize(12).text(`• ${c.name}: ${label}`);
    });

    doc.moveDown();
    doc.fontSize(14).text("Zell-Scores:");
    Object.entries(cellScores).forEach(([k,v])=>{
      doc.fontSize(12).text(`- ${k}: ${v.toFixed(2)} (${ampelfarbe(v)})`);
    });

    doc.moveDown();
    doc.fontSize(14).text("KULTUR-Score:");
    doc.fontSize(12).text(`K (Klarheit): ${kultur.K.toFixed(2)} (${ampelfarbe(kultur.K)})`);
    doc.text(`U (Umsetzung): ${kultur.U.toFixed(2)} (${ampelfarbe(kultur.U)})`);
    doc.text(`L (Lernfähigkeit): ${kultur.L.toFixed(2)} (${ampelfarbe(kultur.L)})`);
    doc.text(`T (Transparenz): ${kultur.T.toFixed(2)} (${ampelfarbe(kultur.T)})`);
    doc.text(`U (Umfeld): ${kultur.U_umfeld.toFixed(2)} (${ampelfarbe(kultur.U_umfeld)})`);
    doc.text(`R (Resilienz): ${kultur.R.toFixed(2)} (${ampelfarbe(kultur.R)})`);

    doc.moveDown();
    doc.fontSize(14).text("3 Entscheidungsfragen:");
    decisions.forEach((q,i)=>doc.fontSize(12).text(`${i+1}. ${q}`));

    doc.moveDown();
    doc.fontSize(14).text("2 Mini-Experimente (30 Tage):");
    experiments.forEach((e,i)=>{
      doc.fontSize(12).text(`${i+1}. Ziel: ${e.ziel}`);
      doc.text(`   Maßnahme: ${e.massnahme}`);
      doc.text(`   Owner: ${e.owner}  |  Start: ${e.start}`);
      doc.text(`   Metrik: ${e.metrik}  |  Check-in: ${e.checkin}`);
      doc.moveDown(0.2);
    });

    doc.end();
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { contact, company, focus, cells, selections } = req.body || {};
    if (!contact?.email || !cells || !selections) {
      return res.status(400).json({ error: "Pflichtfelder fehlen" });
      }

    const map = {
      auftragsstart: 0, ressourcen: 0, uebergabe: 0,
      problem: 0, priorisierung: 0, verantwortung: 0
    };
    for (const c of cells) {
      const pick = selections.find(s=>s.cell_id===c.id);
      const opt = c.options.find(o=>o.id===pick?.selected_option_id);
      map[c.id] = Number(opt?.score_value ?? 0);
    }

    const kultur = calcKultur(map);
    const worst = worstCells(map);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `
Fokus: ${focus}
Schlechteste Zellen: ${"${worst.map(w=>w.id).join(\", \")}"}

Liefere:
- "decision_questions": genau 3 kurze Ja/Nein-taugliche Fragen, um den kleinsten wirksamen Hebel zu finden.
- "experiments": genau 2 Experimente für 30 Tage, Felder: ziel, massnahme, owner, start (heute+7), metrik, checkin (wöch. 10 min).

Nur JSON:
{
  "decision_questions": ["...","...","..."],
  "experiments": [
    {"ziel":"...","massnahme":"...","owner":"Rolle/Name","start":"YYYY-MM-DD","metrik":"...","checkin":"..."},
    {"ziel":"...","massnahme":"...","owner":"Rolle/Name","start":"YYYY-MM-DD","metrik":"...","checkin":"..."}
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
    text = text.replace(/^```json\s*/i, "").replace(/```$/,"");
    const extra = JSON.parse(text);

    const pdfBuffer = await makePdfBuffer({
      company, focus, contact, cells, selections,
      cellScores: map, kultur,
      decisions: extra.decision_questions || [],
      experiments: extra.experiments || []
    });

    await sgMail.send({
      to: contact.email,
      from: process.env.FROM_EMAIL,
      subject: `Ihr QuickScan – ${focus}`,
      text: `Hallo ${"${contact.name || \"\""}}, anbei Ihr QuickScan als PDF.`,
      attachments: [{
        content: pdfBuffer.toString("base64"),
        filename: "QuickScan.pdf",
        type: "application/pdf",
        disposition: "attachment"
      }]
    });

    return res.status(200).json({
      ok: true,
      kultur,
      worst,
      decision_questions: extra.decision_questions || [],
      experiments: extra.experiments || []
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Finish-Fehler", detail: String(err?.message || err) });
  }
}
