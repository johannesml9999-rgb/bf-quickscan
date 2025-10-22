(function(){
  const API_BASE = "https://bf-quickscan-zder.vercel.app/";

  function el(tag, attrs={}, ...kids){
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v])=>{
      if (k==="class") e.className = v;
      else if (k==="style") e.style.cssText = v;
      else e.setAttribute(k,v);
    });
    kids.forEach(k=> e.append(k));
    return e;
  }

  function mount(container){
    let state = { contact:{}, focus:"", cells:[], selections:[] };

    const step1 = el("div", {class:"bf-step"});
    const h1 = el("h3", {}, "QuickScan – Start");
    const p  = el("p", {}, "Bitte trage E-Mail und deinen Fokus ein.");
    const email = el("input", {type:"email", placeholder:"E-Mail", required:"true", style:"width:100%;padding:8px"});
    const name  = el("input", {type:"text", placeholder:"Name (optional)", style:"width:100%;padding:8px;margin-top:6px"});
    const company = el("input", {type:"text", placeholder:"Firma (optional)", style:"width:100%;padding:8px;margin-top:6px"});
    const focus = el("input", {type:"text", placeholder:"Auf welche Linie/Produktfamilie schauen wir?", style:"width:100%;padding:8px;margin-top:6px"});
    const btn1 = el("button", {style:"margin-top:10px;padding:8px 12px"}, "Weiter");

    step1.append(h1,p,email,name,company,focus,btn1);

    const step2 = el("div", {class:"bf-step", style:"display:none"});
    const h2 = el("h3", {}, "Bewertung (6 Felder)");
    const list = el("div");
    const btn2 = el("button", {style:"margin-top:10px;padding:8px 12px"}, "Abschicken & PDF erhalten");
    step2.append(h2, list, btn2);

    const step3 = el("div", {class:"bf-step", style:"display:none"});
    const done = el("h3", {}, "Danke! Schau in dein E-Mail-Postfach.");
    step3.append(done);

    container.append(step1, step2, step3);

    btn1.onclick = async () => {
      if (!email.value || !focus.value) {
        alert("Bitte E-Mail und Fokus ausfüllen.");
        return;
      }
      state.contact = { email: email.value, name: name.value };
      state.company = company.value;
      state.focus = focus.value;

      const r = await fetch(API_BASE + "/api/quickscan/init", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          contact: state.contact,
          focus: state.focus,
          context: ""
        })
      }).then(r=>r.json());

      if (!r.cells) { alert("Konnte Fragen nicht laden."); return; }
      state.cells = r.cells;
      state.selections = [];

      list.innerHTML = "";
      r.cells.forEach(cell=>{
        const wrap = el("div", {style:"border:1px solid #ddd;padding:10px;border-radius:8px;margin:8px 0"});
        wrap.append(el("div",{style:"font-weight:bold"}, cell.name));
        wrap.append(el("div",{style:"font-size:12px;color:#555"}, cell.diagnostic_question));
        const opts = el("div", {style:"margin-top:6px"});
        cell.options.forEach(o=>{
          const id = `${"${cell.id}"}-${"${o.id}"}`;
          const radio = el("input",{type:"radio",name:cell.id,id:id});
          radio.onchange = ()=> {
            const found = state.selections.find(s=>s.cell_id===cell.id);
            if (found){ found.selected_option_id=o.id; found.score_value=o.score_value; }
            else state.selections.push({ cell_id:cell.id, selected_option_id:o.id, score_value:o.score_value });
          };
          const label = el("label",{for:id,style:"display:block;cursor:pointer;margin:4px 0"}, o.label);
          const row = el("div",{}, radio, label);
          opts.append(row);
        });
        wrap.append(opts);
        list.append(wrap);
      });

      step1.style.display = "none";
      step2.style.display = "block";
    };

    btn2.onclick = async () => {
      if (state.selections.length !== 6) {
        alert("Bitte in allen 6 Feldern eine Option wählen.");
        return;
      }
      btn2.disabled = true;
      btn2.textContent = "Bitte warten…";

      const r = await fetch(API_BASE + "/api/quickscan/finish", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          contact: state.contact,
          company: state.company,
          focus: state.focus,
          cells: state.cells,
          selections: state.selections
        })
      }).then(r=>r.json());

      if (!r.ok) {
        alert("Fehler beim Senden. Bitte später erneut versuchen.");
        btn2.disabled = false;
        btn2.textContent = "Abschicken & PDF erhalten";
        return;
      }
      step2.style.display = "none";
      step3.style.display = "block";
    };
  }

  window.addEventListener("DOMContentLoaded", ()=>{
    const mountPoint = document.getElementById("bf-quickscan");
    if (mountPoint) mount(mountPoint);
  });
})();
