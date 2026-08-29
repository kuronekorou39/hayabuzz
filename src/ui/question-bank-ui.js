import { CONFIG } from '../config.js'
import {
  addQuestion,
  applyImport,
  exportPayload,
  getExportedAt,
  importTsv,
  parseImport,
  QUESTION_TYPES,
  removeQuestion,
  saveBank,
  setExportedAt,
  TYPE_LABEL,
  updateQuestion,
} from '../game/question-bank.js'
import { SAMPLE_QUESTIONS } from '../game/sample-questions.js'
import { backdropDismiss, el, popupOverlay } from '../util/dom.js'

// 問題集の UI。出題者のポップアップ（出題つき）と、編集専用ページ（出題なし）で共用する。

// 表示用の答えラベル（○×は記号に、4択は「2. 選択肢」の形にする）
export function answerLabel(type, a, choices = []) {
  if (a === '') return ''
  if (type === 'ox') return a === 'o' ? '○' : '×'
  if (type === 'choice4') {
    const text = choices[Number(a) - 1] ?? ''
    return text !== '' ? `${a}. ${text}` : a
  }
  return a
}

// 形式（早押し/○×/4択）に応じて中身が変わる答えの入力欄。
// 出題カードと問題集の追加フォームで同じ部品を使う
export function createAnswerFields(prefix) {
  const answerInput = el('input', {
    class: `input ${prefix}-a-input`, type: 'text', maxlength: 200,
    placeholder: '答え（任意・判定結果で全員に表示）',
  })
  // 正解を先に決めておくと発表がワンタップになる。「未定」ならその場で選んで発表する
  const oxSelect = el('select', { class: `input ${prefix}-ox-select` }, [
    el('option', { value: '', text: '正解は未定（発表時に選ぶ）' }),
    el('option', { value: 'o', text: '正解は ○' }),
    el('option', { value: 'x', text: '正解は ×' }),
  ])
  const choiceInputs = ['1', '2', '3', '4'].map((n) =>
    el('input', { class: `input ${prefix}-choice-input`, type: 'text', placeholder: `選択肢${n}`, maxlength: 100 }))
  const correctSelect = el('select', { class: `input ${prefix}-correct-select` }, [
    el('option', { value: '', text: '正解は未定（発表時に選ぶ）' }),
    ...['1', '2', '3', '4'].map((n) => el('option', { value: n, text: `正解は ${n}` })),
  ])
  const row = el('div', { class: 'answer-fields' })

  return {
    row,
    sync(type) {
      if (type === 'ox') row.replaceChildren(oxSelect)
      else if (type === 'choice4') row.replaceChildren(...choiceInputs, correctSelect)
      else row.replaceChildren(answerInput)
    },
    // 入力値を { raw: 保存・判定に使う値, choices } で返す
    read(type) {
      if (type === 'ox') return { raw: oxSelect.value, choices: [] }
      if (type === 'choice4') return { raw: correctSelect.value, choices: choiceInputs.map((i) => i.value) }
      return { raw: answerInput.value, choices: [] }
    },
    clear() {
      answerInput.value = ''
      for (const input of choiceInputs) input.value = ''
    },
    // 問題集から読み込んだ内容を入力欄に反映する
    setValues(type, { raw = '', choices = [] } = {}) {
      if (type === 'ox') oxSelect.value = raw
      else if (type === 'choice4') {
        correctSelect.value = raw
        choiceInputs.forEach((input, i) => {
          input.value = choices[i] ?? ''
        })
      } else answerInput.value = raw
    },
    setDisabled(disabled) {
      for (const node of [answerInput, oxSelect, correctSelect, ...choiceInputs]) node.disabled = disabled
    },
  }
}

function formatAskedMeta(item) {
  if (item.history.length === 0) return '未出題'
  const last = item.history[item.history.length - 1]
  const date = new Date(last.at)
  const when = `${date.getMonth() + 1}/${date.getDate()}`
  const winner = last.winner !== null ? ` ${last.winner}` : ' 正解者なし'
  return `${item.history.length}回 · ${when}${winner}`
}

// 問題集のカード本体を作る。
//   items  : 問題の配列（呼び出し側と共有する。保存はこの中で行う）
//   onAsk  : 「出題」を押したときの処理。省略すると出題ボタン自体を出さない（編集専用ページ）
//   canAsk : いま出題できるか（進行中は選ばせない）
export function createBankPanel({ items, onAsk = null, canAsk = () => true }) {
  const bankTypeSelect = el('select', { class: 'input bank-type-select' },
    QUESTION_TYPES.map((t) => el('option', { value: t, text: TYPE_LABEL[t] })))
  const bankQInput = el('textarea', { class: 'input bank-q-input', rows: '2', placeholder: '問題文', maxlength: CONFIG.questionMaxLen })
  const bankFields = createAnswerFields('bank')
  const bankMemoInput = el('input', { class: 'input bank-memo-input', type: 'text', placeholder: 'メモ（判定基準など・任意）', maxlength: 500 })

  bankTypeSelect.addEventListener('change', () => bankFields.sync(bankTypeSelect.value))
  bankFields.sync(bankTypeSelect.value)

  // 追加と編集で同じフォームを使う。editingId が null なら新規追加
  let editingId = null
  const formTitle = el('span', { class: 'form-title', text: '問題を追加' })
  const formError = el('p', { class: 'form-error bank-form-error', text: '' })
  const bankAddBtn = el('button', { class: 'btn btn-primary btn-small', text: '追加する' })
  const bankCancelBtn = el('button', { class: 'btn btn-small hidden', text: 'やめる', onclick: () => resetForm() })

  function resetForm() {
    editingId = null
    bankQInput.value = ''
    bankMemoInput.value = ''
    bankFields.clear()
    formError.textContent = ''
    formTitle.textContent = '問題を追加'
    bankAddBtn.textContent = '追加する'
    bankCancelBtn.classList.add('hidden')
    render()
  }

  // 一覧の「編集」から呼ぶ。フォームに値を入れて開く
  function startEdit(item) {
    editingId = item.id
    bankTypeSelect.value = item.type
    bankFields.sync(item.type)
    bankFields.setValues(item.type, { raw: item.a, choices: item.choices })
    bankQInput.value = item.q
    bankMemoInput.value = item.memo
    formError.textContent = ''
    formTitle.textContent = '問題を編集'
    bankAddBtn.textContent = '保存する'
    bankCancelBtn.classList.remove('hidden')
    setFormOpen(true)
    render()
    bankQInput.focus()
  }

  bankAddBtn.addEventListener('click', () => {
    const type = bankTypeSelect.value
    const { raw, choices } = bankFields.read(type)
    const spec = { type, q: bankQInput.value, a: raw, choices, memo: bankMemoInput.value }
    const saved = editingId !== null ? updateQuestion(items, editingId, spec) : addQuestion(items, spec)
    if (saved === null) {
      formError.textContent =
        bankQInput.value.trim() === '' ? '問題文を入力してください' : '同じ形式・同じ問題文がすでにあります'
      return
    }
    saveBank(items)
    resetForm()
    bankQInput.focus()
  })

  const bankRows = el('div', { class: 'bank-rows' })
  const bankPlaceholder = el('p', { class: 'placeholder', text: 'まだ問題がありません。下の「問題を追加」か、まとめて貼り付けて入れられます' })
  const bankNote = el('p', { class: 'placeholder', text: '出題中は選べません（判定を終えるか、取り消してください）' })
  const bankHint = el('p', { class: 'placeholder', text: '「選ぶ」を押すと出題欄に読み込みます（出題は「全員に出題」で）' })

  // プレースホルダは実際のタブ区切りで書いておく（説明より見た方が早い）
  const bankPaste = el('textarea', {
    class: 'input bank-paste',
    rows: '3',
    placeholder: '日本の首都は？\t東京\n富士山の高さは？\t3776m\tm単位で',
  })
  // 取り込み結果の案内（追加数と、重複などで飛ばした数）
  // 結果は操作したボタンのすぐ下に出す（離れた場所だと画面外になって気づけない）
  const pasteNote = el('p', { class: 'import-note', text: '' })
  const fileNote = el('p', { class: 'import-note', text: '' })

  // 形式ごとの列の並びと、そのまま AI に渡せる依頼文。
  // 並びを説明するより、依頼文をコピーしてもらう方が早い
  const PROMPT_EXAMPLES = [
    {
      type: 'buzzer',
      columns: '問題 / 答え / メモ',
      prompt:
        'クイズを20問作ってください。1行1問、タブ区切りで「問題→答え→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
    {
      type: 'ox',
      columns: '問題 / ○ か × / メモ',
      prompt:
        '○×クイズを20問作ってください。1行1問、タブ区切りで「問題→正解（○か×）→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
    {
      type: 'choice4',
      columns: '問題 / 選択肢1〜4 / 正解番号 / メモ',
      prompt:
        '4択クイズを20問作ってください。1行1問、タブ区切りで' +
        '「問題→選択肢1→選択肢2→選択肢3→選択肢4→正解番号（1〜4）→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
  ]

  const promptRows = PROMPT_EXAMPLES.map(({ type, columns, prompt }) => {
    const copyBtn = el('button', { class: 'btn btn-mini', text: 'AI依頼文', onclick: async () => {
      try {
        await navigator.clipboard.writeText(prompt)
        copyBtn.textContent = 'コピー済'
      } catch {
        // クリップボードが使えない環境では、貼り付け欄に出して手動コピーしてもらう
        bankPaste.value = prompt
        copyBtn.textContent = '下に出しました'
      }
      setTimeout(() => {
        copyBtn.textContent = 'AI依頼文'
      }, 1600)
    } })
    return el('li', {}, [
      el('span', { class: `type-badge type-${type}`, text: TYPE_LABEL[type] }),
      el('span', { class: 'io-columns', text: columns }),
      copyBtn,
    ])
  })

  function reportImport({ added, skipped }, target) {
    const skip = skipped > 0 ? `（重複など ${skipped}問は取り込まず）` : ''
    target.textContent = added > 0 ? `${added}問を追加しました${skip}` : `追加できる問題がありませんでした${skip}`
    target.className = added > 0 ? 'import-note ok' : 'import-note ng'
    for (const other of [pasteNote, fileNote]) {
      if (other !== target) other.textContent = ''
    }
    saveBank(items)
    render()
  }

  const bankImportBtn = el('button', { class: 'btn btn-small btn-primary', text: '貼り付けから追加', onclick: () => {
    const result = importTsv(items, bankPaste.value)
    if (result.added > 0) bankPaste.value = ''
    reportImport(result, pasteNote)
  } })

  // お試し用のサンプル問題（同じ問題は重複して入らない）
  const sampleBtn = el('button', { class: 'btn btn-small', text: 'サンプルを入れる', onclick: () => {
    let added = 0
    let skipped = 0
    for (const sample of SAMPLE_QUESTIONS) {
      if (addQuestion(items, sample) !== null) added += 1
      else skipped += 1
    }
    reportImport({ added, skipped }, pasteNote)
  } })

  const exportNote = el('p', { class: 'io-note export-note', text: '' })
  const exportBtn = el('button', { class: 'btn btn-small', text: 'ファイルに書き出す', onclick: () => {
    const blob = new Blob([exportPayload(items)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = el('a', { href: url, download: `hayabuzz-questions-${new Date().toISOString().slice(0, 10)}.json` })
    link.click()
    URL.revokeObjectURL(url)
    setExportedAt(Date.now())
    render()
  } })
  // 既定は「今の問題集に足す」。チェックすると読み込む前に空にして入れ替える
  const replaceCheck = el('input', { class: 'bank-replace-check', type: 'checkbox' })
  const importFileInput = el('input', { class: 'bank-file-input', type: 'file', accept: 'application/json' })
  importFileInput.addEventListener('change', () => {
    const file = importFileInput.files[0]
    importFileInput.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const questions = parseImport(String(reader.result))
      if (questions === null) {
        fileNote.textContent = '読み込めませんでした（書き出したファイルを選んでください）'
        fileNote.className = 'import-note ng'
        return
      }
      reportImport(applyImport(items, questions, { replace: replaceCheck.checked }), fileNote)
    }
    reader.readAsText(file)
  })
  const importLabel = el('label', { class: 'btn btn-small' }, [
    el('span', { text: 'ファイルを読み込む' }),
    importFileInput,
  ])

  function render() {
    bankPlaceholder.style.display = items.length === 0 ? '' : 'none'
    const askable = onAsk !== null && canAsk()
    bankNote.style.display = onAsk !== null && !askable ? '' : 'none'
    bankRows.replaceChildren(
      ...items.map((item) => {
        const answer = answerLabel(item.type, item.a, item.choices)
        return el('div', { class: item.id === editingId ? 'bank-row editing' : 'bank-row' }, [
          el('div', { class: 'bank-main' }, [
            el('div', { class: 'bank-head' }, [
              el('span', { class: `type-badge type-${item.type}`, text: TYPE_LABEL[item.type] }),
              el('span', { class: 'bank-q', text: item.q }),
            ]),
            el('span', { class: 'bank-meta', text: `${answer !== '' ? `答え: ${answer} · ` : ''}${formatAskedMeta(item)}` }),
          ]),
          el('div', { class: 'bank-actions' }, [
            // 編集専用ページでは出題できないのでボタン自体を出さない。
            // 押すと出題欄に読み込むだけで、出題は「全員に出題」で行う
            ...(onAsk !== null
              ? [el('button', { class: 'btn btn-mini', text: '選ぶ', disabled: !askable, onclick: () => onAsk(item) })]
              : []),
            // フォームを開く操作なので、外タップ扱いで閉じられないよう伝播を止める
            el('button', { class: 'btn btn-mini', text: '編集', onclick: (ev) => {
              ev.stopPropagation()
              startEdit(item)
            } }),
            el('button', { class: 'btn btn-mini btn-ng', text: '削除', onclick: () => {
              removeQuestion(items, item.id)
              saveBank(items)
              if (editingId === item.id) resetForm()
              else render()
            } }),
          ]),
        ])
      }),
    )
    const exportedAt = getExportedAt()
    exportNote.textContent =
      exportedAt !== null ? `前回の書き出し: ${new Date(exportedAt).toLocaleString()}` : 'まだ書き出していません'
    exportNote.className = exportedAt !== null ? 'io-note export-note' : 'io-note export-note warn'
  }

  // 追加・編集フォームは一覧とは別のカードにして下部に貼り付ける。
  // 一覧と地続きに見えないよう独立させ、開閉はスライドで見せる
  const formCaret = el('span', { class: 'form-caret', text: '▲' })
  const formToggle = el('button', { class: 'form-toggle', 'aria-expanded': 'false' }, [
    el('span', { class: 'form-plus', text: '＋' }),
    formTitle,
    formCaret,
  ])
  const formBody = el('div', { class: 'form-body' }, [
    el('div', { class: 'bank-add' }, [
      el('div', { class: 'settings-row' }, [el('span', { text: '形式' }), bankTypeSelect]),
      bankQInput,
      bankFields.row,
      bankMemoInput,
      formError,
      el('div', { class: 'btn-row' }, [bankAddBtn, bankCancelBtn]),
    ]),
  ])
  const formCard = el('div', { class: 'card bank-form' }, [formToggle, formBody])

  function setFormOpen(open) {
    formCard.classList.toggle('open', open)
    formToggle.setAttribute('aria-expanded', String(open))
  }
  formToggle.addEventListener('click', () => setFormOpen(!formCard.classList.contains('open')))
  // 開いたままだと一覧や取り込みの操作を覆ってしまうため、フォームの外をタップしたら閉じる。
  // フォーム内のクリックはここで止める（要素が作り直されても誤判定しないように）
  formCard.addEventListener('click', (ev) => ev.stopPropagation())
  document.addEventListener('click', () => setFormOpen(false))

  // 「まとめて入れる」と「ファイルで持ち運ぶ」は目的が違うので節を分ける。
  // 一覧の枠に混ぜず、独立したポップアップとして重ねて表示する
  const ioOverlay = popupOverlay(
    'io-overlay',
    el('div', { class: 'card rules-card bank-io' }, [
      el('h2', { text: 'まとめて入れる・持ち出す' }),
      el('section', { class: 'io-section' }, [
        el('h3', { class: 'io-title', text: '貼り付けて取り込む' }),
        el('ul', { class: 'io-formats' }, promptRows),
        bankPaste,
        el('div', { class: 'btn-row' }, [bankImportBtn, sampleBtn]),
        pasteNote,
      ]),
      el('section', { class: 'io-section' }, [
        el('h3', { class: 'io-title', text: 'バックアップ・引っ越し' }),
        el('p', { class: 'io-note', text: '問題集をまるごとファイルに保存します。ブラウザの保存は消えることがあるので、このファイルを正本にしてください' }),
        exportNote,
        el('div', { class: 'btn-row' }, [exportBtn, importLabel]),
        el('label', { class: 'settings-row io-replace' }, [
          el('span', { text: '読み込む前に、いまの問題集を空にする' }),
          replaceCheck,
        ]),
        fileNote,
      ]),
    ]),
  )
  backdropDismiss(ioOverlay)
  const ioBtn = el('button', {
    class: 'link-btn',
    text: 'まとめて入れる・持ち出す',
    onclick: () => ioOverlay.classList.remove('hidden'),
  })

  const listCard = el('div', { class: 'card rules-card bank-card' }, [
    // 見出しの右端に入口を置く（一覧の中に節を挟まない）
    el('div', { class: 'bank-head-row' }, [el('h2', { text: '問題集' }), ioBtn]),
    bankNote,
    ...(onAsk !== null ? [bankHint] : []),
    bankPlaceholder,
    bankRows,
  ])
  const root = el('div', { class: 'bank-panel' }, [listCard, formCard])

  render()
  // ioOverlay は呼び出し側で画面に配置する（問題集の上に重ねるため）
  return { root, ioOverlay, render }
}
