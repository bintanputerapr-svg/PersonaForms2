const STORAGE_KEY = "personaforms-studio-v4";
const PASSCODE = "niswahjelek";
const FALLBACK_SLUG = "kuisioner-default";

const backend = {
  enabled: false,
  client: null,
  defaultSlug: FALLBACK_SLUG,
  publicSlug: FALLBACK_SLUG,
  researcherEmail: ""
};

let state = loadState();
let researcherUnlocked = false;
let publicSurvey = null;
let currentResponses = [];

const $ = (selector) => document.querySelector(selector);
const els = {
  respondentView: $("#respondent-view"),
  researcherView: $("#researcher-view"),
  form: $("#survey-form"),
  identityFields: $("#identity-fields"),
  questionFields: $("#question-fields"),
  identityEditor: $("#identity-editor"),
  questionEditor: $("#question-editor"),
  builderTemplate: $("#builder-template"),
  backendStatus: $("#backend-status"),
  publicStatus: $("#public-status"),
  researcherLock: $("#researcher-lock"),
  researcherApp: $("#researcher-app"),
  responsesHead: $("#responses-table thead"),
  responsesBody: $("#responses-table tbody")
};

bindEvents();
init();

async function init() {
  initBackend();
  if (backend.enabled) {
    document.querySelector(".fallback-form")?.classList.add("hidden");
    document.querySelector(".fallback-form + .muted")?.classList.add("hidden");
  }
  await loadPublicSurvey();
  await loadResponses();
  if (backend.enabled) {
    const session = await backend.client.auth.getSession();
    if (session.data.session?.user) {
      researcherUnlocked = true;
      backend.researcherEmail = session.data.session.user.email || "";
      await loadResearcherSurveys();
      await loadResponses();
    }
  }
  renderAll();
}

function bindEvents() {
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewTarget));
  });
  $("#access-form").addEventListener("submit", handleLocalAccess);
  $("#auth-form").addEventListener("submit", handleAuthLogin);
  $("#save-settings").addEventListener("click", saveSurvey);
  $("#add-identity-field").addEventListener("click", () => addField("identity"));
  $("#add-question-field").addEventListener("click", () => addField("question"));
  $("#survey-selector").addEventListener("change", async (event) => {
    state.activeSurveyId = event.target.value;
    persist();
    await loadResponses();
    renderAll();
  });
  $("#new-survey-button").addEventListener("click", () => {
    const survey = createSurvey();
    state.surveys.unshift(survey);
    state.activeSurveyId = survey.id;
    persist();
    loadResponses().then(renderAll);
  });
  $("#duplicate-survey-button").addEventListener("click", () => {
    const survey = activeSurvey();
    if (!survey) return;
    const copy = cloneSurvey(survey);
    state.surveys.unshift(copy);
    state.activeSurveyId = copy.id;
    persist();
    loadResponses().then(renderAll);
  });
  $("#delete-survey-button").addEventListener("click", deleteSurvey);
  $("#open-public-link").addEventListener("click", () => {
    const survey = activeSurvey();
    if (survey) window.open(buildShareLink(survey.slug), "_blank", "noopener,noreferrer");
  });
  $("#download-csv").addEventListener("click", downloadCsv);
  $("#clear-responses").addEventListener("click", clearResponses);
  $("#sign-out-button").addEventListener("click", async () => {
    if (backend.enabled) await backend.client.auth.signOut();
    researcherUnlocked = false;
    backend.researcherEmail = "";
    renderAll();
  });
  els.form.addEventListener("submit", submitResponse);
}

function initBackend() {
  const config = window.SUPABASE_CONFIG || {};
  backend.defaultSlug = config.surveySlug || FALLBACK_SLUG;
  backend.publicSlug = requestedSlug() || backend.defaultSlug;
  if (!config.url || !config.anonKey || !window.supabase?.createClient) {
    setStatus(els.backendStatus, "warning", "Supabase belum dikonfigurasi. Aplikasi masih bisa dipakai secara lokal.");
    return;
  }
  backend.client = window.supabase.createClient(config.url, config.anonKey);
  backend.enabled = true;
  setStatus(els.backendStatus, "connected", "Supabase aktif. Kuisioner bisa disimpan online dan dibagikan lewat internet.");
}

async function loadPublicSurvey() {
  if (!backend.enabled) {
    publicSurvey = structuredClone(state.surveys.find((survey) => survey.slug === requestedSlug()) || activeSurvey());
    setStatus(els.publicStatus, "connected", "Menampilkan kuisioner dari penyimpanan lokal.");
    return;
  }

  const surveyResult = await backend.client.from("surveys")
    .select("id, slug, title, description, is_published")
    .eq("slug", backend.publicSlug)
    .eq("is_published", true)
    .maybeSingle();

  if (surveyResult.error || !surveyResult.data) {
    publicSurvey = structuredClone(activeSurvey());
    setStatus(els.publicStatus, "warning", `Kuisioner publik tidak ditemukan untuk slug "${backend.publicSlug}".`);
    return;
  }

  const fieldsResult = await backend.client.from("survey_fields")
    .select("id, section, position, label, field_type, required, options, placeholder, scale_steps, left_label, right_label")
    .eq("survey_id", surveyResult.data.id)
    .order("position", { ascending: true });

  publicSurvey = hydrateSurvey(surveyResult.data, fieldsResult.data || []);
  setStatus(els.publicStatus, "connected", `Kuisioner publik aktif: ${publicSurvey.title}`);
}

async function loadResearcherSurveys() {
  if (!backend.enabled || !researcherUnlocked) return;
  const surveysResult = await backend.client.from("surveys")
    .select("id, slug, title, description, is_published")
    .order("updated_at", { ascending: false });
  if (surveysResult.error) return;

  const surveys = [];
  for (const row of surveysResult.data || []) {
    const fieldsResult = await backend.client.from("survey_fields")
      .select("id, section, position, label, field_type, required, options, placeholder, scale_steps, left_label, right_label")
      .eq("survey_id", row.id)
      .order("position", { ascending: true });
    surveys.push(hydrateSurvey(row, fieldsResult.data || []));
  }

  if (surveys.length > 0) {
    state.surveys = surveys;
    if (!state.surveys.some((survey) => survey.id === state.activeSurveyId)) state.activeSurveyId = state.surveys[0].id;
    persist();
  }
}

async function loadResponses() {
  const survey = activeSurvey();
  if (!survey) return;
  if (backend.enabled && researcherUnlocked && survey.remoteId) {
    const result = await backend.client.from("survey_responses")
      .select("submitted_at, identity, answers")
      .eq("survey_id", survey.remoteId)
      .order("submitted_at", { ascending: false });
    currentResponses = (result.data || []).map((row) => ({
      submittedAt: new Date(row.submitted_at).toLocaleString("id-ID"),
      identity: row.identity || {},
      answers: row.answers || {}
    }));
    state.responsesBySurvey[survey.id] = currentResponses;
    persist();
    return;
  }
  currentResponses = state.responsesBySurvey[survey.id] || [];
}

async function handleAuthLogin(event) {
  event.preventDefault();
  if (!backend.enabled) return alert("Isi Supabase dulu atau gunakan akses lokal.");
  const email = $("#researcher-email").value.trim();
  const password = $("#researcher-password").value;
  const result = await backend.client.auth.signInWithPassword({ email, password });
  if (result.error) return alert(`Login gagal: ${result.error.message}`);
  researcherUnlocked = true;
  backend.researcherEmail = result.data.user?.email || email;
  await loadResearcherSurveys();
  await loadResponses();
  renderAll();
}

function handleLocalAccess(event) {
  event.preventDefault();
  if (backend.enabled) return alert("Akses lokal dinonaktifkan saat mode online aktif.");
  if ($("#access-code").value.trim() !== PASSCODE) return alert("Password lokal salah.");
  researcherUnlocked = true;
  renderAll();
}

async function saveSurvey() {
  const survey = activeSurvey();
  if (!survey) return;
  survey.title = $("#survey-title").value.trim() || "Kuisioner tanpa judul";
  survey.slug = uniqueSlug($("#survey-slug").value, survey.id);
  survey.description = $("#survey-description").value.trim();
  survey.isPublished = $("#survey-published").checked;
  persist();

  if (!backend.enabled) {
    await loadPublicSurvey();
    renderAll();
    return alert("Kuisioner tersimpan lokal. Aktifkan Supabase untuk berbagi lewat internet.");
  }
  if (!researcherUnlocked) return alert("Login peneliti terlebih dahulu.");

  const user = (await backend.client.auth.getSession()).data.session?.user;
  if (!user) return alert("Sesi login tidak ditemukan.");

  const payload = {
    slug: survey.slug,
    title: survey.title,
    description: survey.description,
    is_published: survey.isPublished,
    researcher_user_id: user.id
  };

  if (!survey.remoteId) {
    const inserted = await backend.client.from("surveys").insert(payload).select("id").single();
    if (inserted.error) return alert(`Gagal membuat kuisioner: ${inserted.error.message}`);
    survey.remoteId = inserted.data.id;
  } else {
    const updated = await backend.client.from("surveys").update(payload).eq("id", survey.remoteId);
    if (updated.error) return alert(`Gagal memperbarui kuisioner: ${updated.error.message}`);
    const deleted = await backend.client.from("survey_fields").delete().eq("survey_id", survey.remoteId);
    if (deleted.error) return alert(`Gagal mereset field: ${deleted.error.message}`);
  }

  const rows = [
    ...survey.identityFields.map((field, index) => fieldRow(field, survey.remoteId, "identity", index)),
    ...survey.questions.map((field, index) => fieldRow(field, survey.remoteId, "question", index))
  ];
  if (rows.length) {
    const insertedFields = await backend.client.from("survey_fields").insert(rows);
    if (insertedFields.error) return alert(`Gagal menyimpan field: ${insertedFields.error.message}`);
  }

  await loadResearcherSurveys();
  await loadResponses();
  await loadPublicSurvey();
  renderAll();
  alert("Struktur kuisioner berhasil disimpan ke Supabase.");
}

function addField(section) {
  const survey = activeSurvey();
  if (!survey) return;
  const field = section === "identity"
    ? createField("Kolom identitas baru", "shortText", false)
    : createField("Pertanyaan baru", "multipleChoice", true, ["Opsi 1", "Opsi 2"]);
  survey[section === "identity" ? "identityFields" : "questions"].push(field);
  persist();
  renderAll();
}

async function deleteSurvey() {
  const survey = activeSurvey();
  if (!survey || !confirm(`Hapus kuisioner "${survey.title}"?`)) return;
  if (backend.enabled && researcherUnlocked && survey.remoteId) {
    const deleted = await backend.client.from("surveys").delete().eq("id", survey.remoteId);
    if (deleted.error) return alert(`Gagal menghapus kuisioner: ${deleted.error.message}`);
  }
  state.surveys = state.surveys.filter((item) => item.id !== survey.id);
  if (!state.surveys.length) state.surveys = [createSurvey()];
  state.activeSurveyId = state.surveys[0].id;
  persist();
  await loadPublicSurvey();
  await loadResponses();
  renderAll();
}

async function clearResponses() {
  const survey = activeSurvey();
  if (!survey || !confirm("Hapus semua respons kuisioner aktif?")) return;
  if (backend.enabled && researcherUnlocked && survey.remoteId) {
    const deleted = await backend.client.from("survey_responses").delete().eq("survey_id", survey.remoteId);
    if (deleted.error) return alert(`Gagal menghapus respons: ${deleted.error.message}`);
  }
  state.responsesBySurvey[survey.id] = [];
  currentResponses = [];
  persist();
  renderResponsesTable();
}

async function submitResponse(event) {
  event.preventDefault();
  if (!publicSurvey) return;
  const data = new FormData(els.form);
  const response = { submittedAt: new Date().toLocaleString("id-ID"), identity: {}, answers: {} };

  for (const field of publicSurvey.identityFields) {
    const value = readValue(data, field);
    if (field.required && emptyValue(value)) return alert(`Kolom "${field.label}" wajib diisi.`);
    response.identity[field.id] = normalizeAnswer(value);
  }
  for (const field of publicSurvey.questions.filter(isAnswerField)) {
    const value = readValue(data, field);
    if (field.required && emptyValue(value)) return alert(`Pertanyaan "${field.label}" wajib diisi.`);
    response.answers[field.id] = normalizeAnswer(value);
  }

  if (backend.enabled) {
    if (!publicSurvey.remoteId) return alert("Kuisioner belum tersimpan di database.");
    const inserted = await backend.client.from("survey_responses").insert({
      survey_id: publicSurvey.remoteId,
      identity: response.identity,
      answers: response.answers
    });
    if (inserted.error) return alert(`Gagal mengirim jawaban: ${inserted.error.message}`);
  } else {
    const key = publicSurvey.id;
    if (!state.responsesBySurvey[key]) state.responsesBySurvey[key] = [];
    state.responsesBySurvey[key].unshift(response);
    persist();
  }

  els.form.reset();
  await loadResponses();
  renderResponsesTable();
  alert("Jawaban berhasil dikirim.");
}

function renderAll() {
  const survey = activeSurvey();
  if (!backend.enabled) {
    publicSurvey = structuredClone(state.surveys.find((item) => item.slug === requestedSlug()) || survey);
  }
  $("#hero-title").textContent = publicSurvey?.title || survey?.title || "PersonaForms";
  $("#hero-description").textContent = publicSurvey?.description || survey?.description || "";
  $("#respondent-title").textContent = publicSurvey?.title || "Kuisioner";
  $("#respondent-description").textContent = publicSurvey?.description || "";
  renderPublicForm();
  renderSurveyManager();
  renderBuilder(els.identityEditor, survey?.identityFields || [], "Identitas", "identityFields");
  renderBuilder(els.questionEditor, survey?.questions || [], "Pertanyaan", "questions");
  renderResponsesTable();
  $("#researcher-lock").classList.toggle("hidden", researcherUnlocked);
  $("#researcher-app").classList.toggle("hidden", !researcherUnlocked);
  $("#sign-out-button").classList.toggle("hidden", !(backend.enabled && researcherUnlocked));
}

function renderPublicForm() {
  els.identityFields.innerHTML = "";
  els.questionFields.innerHTML = "";
  if (!publicSurvey) return;
  const identityFields = publicSurvey.identityFields || [];
  const questions = publicSurvey.questions || [];
  els.identityFields.innerHTML = identityFields.length ? "" : `<div class="empty-state">Bagian identitas belum diatur.</div>`;
  els.questionFields.innerHTML = questions.length ? "" : `<div class="empty-state">Belum ada pertanyaan.</div>`;
  identityFields.forEach((field, index) => els.identityFields.appendChild(renderField(field, index, "Identitas")));
  questions.forEach((field, index) => els.questionFields.appendChild(renderField(field, index, "Item")));
}

function renderField(field, index, prefix) {
  const card = document.createElement("article");
  card.className = field.type === "statement" ? "rendered-field statement-card" : "rendered-field";
  card.innerHTML = `<p class="eyebrow accent">${prefix} ${index + 1}${field.required && isAnswerField(field) ? " - wajib" : ""}</p><h5>${escape(field.label)}</h5>`;
  if (field.type === "statement") {
    const note = document.createElement("p");
    note.className = "panel-note";
    note.textContent = field.placeholder || "Pernyataan ini tidak membutuhkan jawaban.";
    card.appendChild(note);
    return card;
  }
  card.appendChild(renderInput(field));
  return card;
}

function renderInput(field) {
  if (field.type === "shortText" || field.type === "longText") {
    const el = document.createElement(field.type === "shortText" ? "input" : "textarea");
    if (field.type === "shortText") el.type = "text";
    if (field.type === "longText") el.rows = 5;
    el.name = field.id;
    el.placeholder = field.placeholder || (field.type === "shortText" ? "Jawaban singkat" : "Tuliskan jawaban");
    el.required = field.required;
    el.style.marginTop = "16px";
    return el;
  }
  if (["multipleChoice", "multipleChoiceOther", "checkboxes"].includes(field.type)) return renderChoices(field);
  if (field.type === "scaleAgree") return renderScale(field);
  return document.createElement("div");
}

function renderChoices(field) {
  const stack = document.createElement("div");
  stack.className = "choice-stack";
  field.options.forEach((option) => {
    const label = document.createElement("label");
    label.className = "choice-chip";
    const input = document.createElement("input");
    input.type = field.type === "checkboxes" ? "checkbox" : "radio";
    input.name = field.id;
    input.value = option;
    input.required = field.required && field.type !== "checkboxes";
    const text = document.createElement("span");
    text.textContent = option;
    label.append(input, text);
    stack.appendChild(label);
  });
  if (field.type === "multipleChoiceOther") {
    const other = document.createElement("label");
    other.className = "choice-chip";
    other.innerHTML = `<input type="radio" name="${field.id}" value="__other__"><span>Lainnya</span><input type="text" name="${field.id}__other" placeholder="Tulis jawaban lain">`;
    stack.appendChild(other);
  }
  return stack;
}

function renderScale(field) {
  const wrap = document.createElement("div");
  wrap.className = "scale-response";
  const left = document.createElement("span");
  left.className = "muted scale-side scale-side-left";
  left.textContent = field.leftLabel || "Sangat tidak setuju";
  const right = document.createElement("span");
  right.className = "muted scale-side scale-side-right";
  right.textContent = field.rightLabel || "Sangat setuju";
  const bubbles = document.createElement("div");
  bubbles.className = "scale-bubbles";
  scaleStyles(field.scaleSteps).forEach((style, index) => {
    const label = document.createElement("label");
    label.className = `bubble-option ${style}`;
    label.setAttribute("aria-label", `Skala ${index + 1}`);
    label.style.setProperty("--bubble-size", `${scaleSizes(field.scaleSteps)[index]}px`);
    label.innerHTML = `<input type="radio" name="${field.id}" value="${index + 1}" ${field.required ? "required" : ""}><span></span>`;
    bubbles.appendChild(label);
  });
  wrap.append(left, bubbles, right);
  return wrap;
}

function renderSurveyManager() {
  const survey = activeSurvey();
  $("#survey-selector").innerHTML = state.surveys.map((item) => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join("");
  $("#survey-selector").value = survey?.id || "";
  $("#survey-title").value = survey?.title || "";
  $("#survey-description").value = survey?.description || "";
  $("#survey-slug").value = survey?.slug || "";
  $("#survey-published").checked = Boolean(survey?.isPublished);
  $("#share-link").value = buildShareLink(survey?.slug || backend.defaultSlug);
}

function renderBuilder(container, fields, labelPrefix, key) {
  container.innerHTML = fields.length ? "" : `<div class="empty-state">Belum ada item.</div>`;
  fields.forEach((field, index) => {
    const node = els.builderTemplate.content.cloneNode(true);
    node.querySelector(".builder-number").textContent = `${labelPrefix} ${index + 1}`;
    node.querySelector(".field-label-input").value = field.label;
    node.querySelector(".field-type-select").value = field.type;
    node.querySelector(".field-placeholder-input").value = field.placeholder || "";
    node.querySelector(".field-required").checked = field.required;
    node.querySelector(".field-options-input").value = field.options.join("\n");
    node.querySelector(".field-scale-steps").value = field.scaleSteps;
    node.querySelector(".field-left-label").value = field.leftLabel || "";
    node.querySelector(".field-right-label").value = field.rightLabel || "";
    const optionsBlock = node.querySelector(".options-only");
    const scaleBlock = node.querySelector(".scale-only");
    optionsBlock.classList.toggle("hidden", !["multipleChoice", "multipleChoiceOther", "checkboxes"].includes(field.type));
    scaleBlock.classList.toggle("hidden", field.type !== "scaleAgree");
    if (field.type === "statement") node.querySelector(".field-required").disabled = true;

    const survey = activeSurvey();
    const ref = survey[key][index];
    node.querySelector(".field-label-input").addEventListener("input", (e) => updateField(ref, "label", e.target.value, false));
    node.querySelector(".field-type-select").addEventListener("change", (e) => {
      ref.type = e.target.value;
      if (ref.type === "statement") ref.required = false;
      if (["multipleChoice", "multipleChoiceOther", "checkboxes"].includes(ref.type) && !ref.options.length) ref.options = ["Opsi 1", "Opsi 2"];
      persist();
      renderAll();
    });
    node.querySelector(".field-placeholder-input").addEventListener("input", (e) => updateField(ref, "placeholder", e.target.value, false));
    node.querySelector(".field-required").addEventListener("change", (e) => updateField(ref, "required", e.target.checked, false));
    node.querySelector(".field-options-input").addEventListener("input", (e) => {
      ref.options = e.target.value.split("\n").map((item) => item.trim()).filter(Boolean);
      persist();
      renderPublicForm();
      renderResponsesTable();
    });
    node.querySelector(".field-scale-steps").addEventListener("input", (e) => updateField(ref, "scaleSteps", clamp(e.target.value, 2, 10, 5), false));
    node.querySelector(".field-left-label").addEventListener("input", (e) => updateField(ref, "leftLabel", e.target.value, false));
    node.querySelector(".field-right-label").addEventListener("input", (e) => updateField(ref, "rightLabel", e.target.value, false));
    node.querySelector(".remove-field").addEventListener("click", () => {
      survey[key] = survey[key].filter((item) => item.id !== ref.id);
      persist();
      renderAll();
    });
    container.appendChild(node);
  });
}

function renderResponsesTable() {
  const survey = activeSurvey();
  if (!survey) return;
  const questions = survey.questions.filter(isAnswerField);
  const columns = [{ key: "submittedAt", label: "Waktu Kirim", source: "root" }]
    .concat(survey.identityFields.map((field) => ({ key: field.id, label: field.label, source: "identity" })))
    .concat(questions.map((field) => ({ key: field.id, label: field.label, source: "answers" })));
  els.responsesHead.innerHTML = `<tr>${columns.map((column) => `<th>${escape(column.label)}</th>`).join("")}</tr>`;
  if (!currentResponses.length) {
    els.responsesBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-state">Belum ada respons untuk kuisioner ini.</td></tr>`;
    return;
  }
  els.responsesBody.innerHTML = currentResponses.map((response) => {
    const cells = columns.map((column) => {
      const value = column.source === "root" ? response.submittedAt : response[column.source]?.[column.key];
      return `<td>${escape(display(value))}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
}

function updateField(field, key, value, rerender = true) {
  field[key] = value;
  persist();
  if (rerender) {
    renderAll();
    return;
  }
  renderPublicForm();
  renderResponsesTable();
}

function fieldRow(field, surveyId, section, position) {
  return {
    survey_id: surveyId,
    section,
    position,
    label: field.label,
    field_type: field.type,
    required: field.type === "statement" ? false : field.required,
    options: field.options,
    placeholder: field.placeholder || null,
    scale_steps: field.type === "scaleAgree" ? field.scaleSteps : null,
    left_label: field.type === "scaleAgree" ? field.leftLabel : null,
    right_label: field.type === "scaleAgree" ? field.rightLabel : null
  };
}

function hydrateSurvey(row, fields) {
  const survey = {
    id: row.id,
    remoteId: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || "",
    isPublished: row.is_published !== false,
    identityFields: [],
    questions: []
  };
  fields.forEach((rowField) => {
    const field = createField(rowField.label, rowField.field_type, rowField.required, rowField.options || [], {
      id: rowField.id,
      placeholder: rowField.placeholder || "",
      scaleSteps: clamp(rowField.scale_steps, 2, 10, 5),
      leftLabel: rowField.left_label || "Sangat tidak setuju",
      rightLabel: rowField.right_label || "Sangat setuju"
    });
    survey[rowField.section === "identity" ? "identityFields" : "questions"].push(field);
  });
  return survey;
}

function createSurvey() {
  const id = crypto.randomUUID();
  return {
    id,
    remoteId: "",
    slug: `${FALLBACK_SLUG}-${id.slice(0, 6)}`,
    title: "Kuisioner Penelitian Baru",
    description: "Isi kuisioner ini sesuai pengalaman Anda. Jawaban akan dipakai untuk keperluan penelitian.",
    isPublished: true,
    identityFields: [
      createField("Nama atau inisial", "shortText", true),
      createField("Usia", "shortText", true)
    ],
    questions: [
      createField("Pilih tingkat persetujuan Anda terhadap pernyataan berikut.", "statement", false, [], { placeholder: "Gunakan skala dari kiri ke kanan." }),
      createField("Saya merasa layanan yang saya terima sudah sesuai harapan.", "scaleAgree", true, [], { scaleSteps: 7, leftLabel: "Sangat tidak setuju", rightLabel: "Sangat setuju" }),
      createField("Media yang paling sering Anda gunakan adalah...", "checkboxes", true, ["Buku", "Video", "Diskusi", "Artikel"]),
      createField("Apa saran Anda untuk perbaikan ke depan?", "longText", false, [], { placeholder: "Tuliskan masukan Anda" })
    ]
  };
}

function cloneSurvey(survey) {
  const copy = structuredClone(survey);
  copy.id = crypto.randomUUID();
  copy.remoteId = "";
  copy.slug = uniqueSlug(`${survey.slug}-salinan`, survey.id);
  copy.title = `${survey.title} (Salinan)`;
  copy.identityFields.forEach((field) => { field.id = crypto.randomUUID(); });
  copy.questions.forEach((field) => { field.id = crypto.randomUUID(); });
  return copy;
}

function createField(label, type, required, options = [], extra = {}) {
  return {
    id: extra.id || crypto.randomUUID(),
    label,
    type,
    required,
    options,
    placeholder: extra.placeholder || "",
    scaleSteps: extra.scaleSteps || 5,
    leftLabel: extra.leftLabel || "Sangat tidak setuju",
    rightLabel: extra.rightLabel || "Sangat setuju"
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = { surveys: [createSurvey()], activeSurveyId: "", responsesBySurvey: {} };
    initial.activeSurveyId = initial.surveys[0].id;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
  const parsed = JSON.parse(raw);
  const surveys = Array.isArray(parsed.surveys) && parsed.surveys.length ? parsed.surveys : [createSurvey()];
  return {
    surveys,
    activeSurveyId: parsed.activeSurveyId || surveys[0].id,
    responsesBySurvey: parsed.responsesBySurvey || {}
  };
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function activeSurvey() {
  return state.surveys.find((survey) => survey.id === state.activeSurveyId) || state.surveys[0] || null;
}

function requestedSlug() {
  const params = new URLSearchParams(window.location.search);
  return params.get("form") || params.get("slug") || "";
}

function uniqueSlug(value, ignoreId = "") {
  const base = slugify(value || "kuisioner-baru");
  let slug = base;
  let count = 2;
  while (state.surveys.some((survey) => survey.id !== ignoreId && survey.slug === slug)) {
    slug = `${base}-${count}`;
    count += 1;
  }
  return slug;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-") || `${FALLBACK_SLUG}-${crypto.randomUUID().slice(0, 6)}`;
}

function buildShareLink(slug) {
  const url = new URL(window.location.href);
  url.searchParams.set("form", slug);
  return url.toString();
}

function setStatus(node, kind, text) {
  node.className = "status-card";
  node.classList.add(kind);
  node.textContent = text;
}

function readValue(data, field) {
  if (field.type === "checkboxes") return data.getAll(field.id).map(String).filter(Boolean);
  if (field.type === "multipleChoiceOther") {
    const selected = data.get(field.id);
    return selected === "__other__" ? (data.get(`${field.id}__other`) || "").toString().trim() : (selected || "").toString().trim();
  }
  return (data.get(field.id) || "").toString().trim();
}

function normalizeAnswer(value) {
  return Array.isArray(value) ? value : (value || "-");
}

function emptyValue(value) {
  return Array.isArray(value) ? value.length === 0 : !String(value || "").trim();
}

function isAnswerField(field) {
  return field.type !== "statement";
}

function scaleStyles(steps) {
  const list = [];
  for (let index = 0; index < steps; index += 1) {
    if (steps % 2 === 1 && index === Math.floor(steps / 2)) list.push("neutral");
    else if (index < steps / 2) list.push("disagree");
    else list.push("agree");
  }
  return list;
}

function scaleSizes(steps) {
  const isMobile = window.matchMedia("(max-width: 920px)").matches;
  const center = (steps - 1) / 2;
  const edgeSize = isMobile
    ? (steps >= 9 ? 32 : steps >= 7 ? 36 : 40)
    : 60;
  const centerSize = isMobile
    ? (steps >= 9 ? 18 : steps >= 7 ? 22 : 28)
    : 44;

  return Array.from({ length: steps }, (_, index) => {
    const distance = Math.abs(index - center);
    const factor = center === 0 ? 1 : distance / center;
    return Math.round(centerSize + factor * (edgeSize - centerSize));
  });
}

function downloadCsv() {
  const survey = activeSurvey();
  if (!survey) return;
  const questions = survey.questions.filter(isAnswerField);
  const rows = [
    ["Waktu Kirim", ...survey.identityFields.map((field) => field.label), ...questions.map((field) => field.label)],
    ...currentResponses.map((response) => [
      response.submittedAt,
      ...survey.identityFields.map((field) => display(response.identity?.[field.id] || "")),
      ...questions.map((field) => display(response.answers?.[field.id] || ""))
    ])
  ];
  const csv = rows.map((row) => row.map(csvValue).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${survey.slug}-responses.csv`;
  link.click();
}

function csvValue(value) {
  const text = display(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function display(value) {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "-");
}

function clamp(value, min, max, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function switchView(target) {
  els.respondentView.classList.toggle("hidden", target !== "respondent");
  els.researcherView.classList.toggle("hidden", target !== "researcher");
}
