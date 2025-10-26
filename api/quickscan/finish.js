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

async function makePdfBuffer({ company, focus, contact, cells, selections, cellScores, kultur, decisions, experiments }) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  const done = new Promise(resolve => doc.on("end", () => resolve(Buffer.concat(chunks))));

  // Farben/Fonts
  const brand = "#0F172A"; // Headlines
  doc.registerFont("Helvetica", "Helvetica");
  doc.registerFont("Helvetica-Bold", "Helvetica-Bold");

  // Optional: Logo oben rechts (wenn LOGO_URL gesetzt)
  try {
    if (process.env.LOGO_URL) {
      const resp = await fetch(process.env.LOGO_URL);
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        doc.image(buf, 440, 40, { width: 120 }); // passt automatisch
      }
    }
  } catch (_) {}

  // Header
  doc.fillColor(brand).font("Helvetica-Bold").fontSize(20).text("QuickScan – Ergebnis");
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#000").text(`Firma: ${company || "-"}`);
  doc.text(`Kontakt: ${contact?.name || "-"} <${contact?.email || "-"}>`);
  doc.text(`Fokus: ${focus}`);
  doc.moveDown(0.6);

  // Legende
  doc.fontSize(10).fillColor("#000").text("Legende:");
  badge(doc, "🔴 kritisch", "#E53935", doc.x, doc.y+2);
  badge(doc, "🟠 schwankend", "#FB8C00", doc.x+110, doc.y+2);
  badge(doc, "🟢 stabil", "#43A047", doc.x+250, doc.y+2);
  doc.moveDown(2);

  // SECTION 1 – Auswahl + Balken je Zelle
  doc.font("Helvetica-Bold").fillColor(brand).fontSize(14).text("1) Bewertung der 6 Reibungspunkte");
  doc.moveDown(0.5);

  const niceName = {
    auftragsstart: "Anforderungen & Auftragsstart",
    ressourcen: "Ressourcenverfügbarkeit",
    uebergabe: "Übergaben & Kommunikation",
    problem: "Problemmanagement",
    priorisierung: "Priorisierung & (Fein-)Planung",
    verantwortung: "Verantwortlichkeiten & Entscheidungen"
  };

  const startX = 40, barW = 350, barH = 10;
  Object.entries(cellScores).forEach(([id,score])=>{
    const cell = cells.find(c=>c.id===id);
    const pick = selections.find(s=>s.cell_id===id);
    const label = cell?.options.find(o=>o.id===pick?.selected_option_id)?.label || "-";

    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fillColor("#000").fontSize(11).text(niceName[id] || id);
    doc.font("Helvetica").fontSize(10).fillColor("#555").text(label, { width: 500 });
    const y = doc.y + 4;
    drawBar(doc, startX, y, barW, barH, score);
    badge(doc, `${score.toFixed(2)} · ${scoreLabel(score)}`, scoreColor(score), startX + barW + 12, y-2);
    doc.moveDown(1.2);
  });

  // SECTION 2 – KULTUR Ampeln
  doc.addPage();
  doc.font("Helvetica-Bold").fillColor(brand).fontSize(14).text("2) KULTUR-Score (0–3) mit Ampel");
  doc.moveDown(0.8);

  const KMAP = [
    ["K (Klarheit)", kultur.K],
    ["U (Umsetzung)", kultur.U],
    ["L (Lernfähigkeit)", kultur.L],
    ["T (Transparenz)", kultur.T],
    ["U (Umfeld)", kultur.U_umfeld],
    ["R (Resilienz)", kultur.R]
  ];

  KMAP.forEach(([name,val])=>{
    doc.font("Helvetica-Bold").fillColor("#000").fontSize(11).text(name);
    const y = doc.y + 4;
    drawBar(doc, startX, y, barW, barH, val);
    badge(doc, `${val.toFixed(2)} · ${scoreLabel(val)}`, scoreColor(val), startX + barW + 12, y-2);
    doc.moveDown(1.2);
  });

  // SECTION 3 – Entscheidungsfragen & Experimente
  doc.addPage();
  doc.font("Helvetica-Bold").fillColor(brand).fontSize(14).text("3) Kleinstmöglicher Hebel & 30-Tage-Experimente");
  doc.moveDown(0.6);

  doc.font("Helvetica-Bold").fillColor("#000").fontSize(12).text("Entscheidungsfragen (3x kurz):");
  doc.font("Helvetica").fontSize(11).fillColor("#333");
  decisions.forEach((q,i)=> doc.text(`${i+1}. ${q}`));
  doc.moveDown(0.8);

  doc.font("Helvetica-Bold").fillColor("#000").fontSize(12).text("Experimente (je 30 Tage):");
  experiments.forEach((e,i)=>{
    doc.font("Helvetica-Bold").fontSize(11).text(`${i+1}. Ziel: ${e.ziel}`);
    doc.font("Helvetica").fontSize(11).text(`   Maßnahme: ${e.massnahme}`);
    doc.text(`   Owner: ${e.owner}    Start: ${e.start}`);
    doc.text(`   Metrik: ${e.metrik}   Check-in: ${e.checkin}`);
    doc.moveDown(0.6);
  });

  // Footer
  doc.moveDown(1);
  doc.fontSize(9).fillColor("#777")
     .text("Businessfalken · QuickScan Auto-Report", { align: "right" });

  doc.end();
  return done;
}

function scoreColor(x) {
  if (x < 1.0) return "#E53935";   // rot
  if (x < 2.0) return "#FB8C00";   // orange
  return "#43A047";                // grün
}
function scoreLabel(x) {
  if (x < 1.0) return "🔴 kritisch";
  if (x < 2.0) return "🟠 schwankend";
  return "🟢 stabil";
}

// hübscher Balken (0–3 -> 0–100%)
function drawBar(doc, x, y, w, h, score) {
  const pct = Math.max(0, Math.min(1, score / 3));
  doc.save();
  doc.roundedRect(x, y, w, h, 3).fill("#ECEFF1");
  doc.fillColor(scoreColor(score))
     .roundedRect(x, y, w * pct, h, 3)
     .fill();
  doc.restore();
}

// kleine farbige „Badge“
function badge(doc, text, color, x, y) {
  const pad = 4;
  const w = doc.widthOfString(text) + pad*2;
  const h = 14;
  doc.save();
  doc.fillColor(color).roundedRect(x, y, w, h, 7).fill();
  doc.fillColor("#FFFFFF").fontSize(9).text(text, x+pad, y+2, {width:w, align:"center"});
  doc.restore();
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
