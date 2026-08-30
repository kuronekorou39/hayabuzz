import { CONFIG } from '../config.js'
import {
  addQuestion,
  applyImport,
  exportPayload,
  filterQuestions,
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
import { showToast } from './toast.js'

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

  // 一覧で選んでいる1問。編集・削除・出題はこの選択に対して行う
  let selectedId = null
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

  // --- 絞り込み（問題が増えると目的の1問が探せなくなるため） ---
  const filterText = el('input', {
    class: 'input bank-filter-text', type: 'text', maxlength: 100,
    placeholder: '問題文・答え・メモで探す',
  })
  const filterType = el('select', { class: 'input bank-filter-type' }, [
    el('option', { value: '', text: 'すべての形式' }),
    ...QUESTION_TYPES.map((t) => el('option', { value: t, text: TYPE_LABEL[t] })),
  ])
  filterText.addEventListener('input', () => render())
  filterType.addEventListener('change', () => render())
  const filterRow = el('div', { class: 'bank-filter' }, [filterText, filterType])
  const filterCount = el('span', { text: '' })
  const filterStatus = el('div', { class: 'bank-filter-status' }, [
    filterCount,
    el('button', { class: 'link-btn', text: '絞り込みを解除', onclick: () => {
      filterText.value = ''
      filterType.value = ''
      render()
    } }),
  ])

  const bankRows = el('div', { class: 'bank-rows' })
  const bankPlaceholder = el('p', { class: 'placeholder', text: 'まだ問題がありません。下の「問題を追加」か、まとめて貼り付けて入れられます' })
  const bankNoMatch = el('p', { class: 'placeholder', text: '見つかりませんでした' })
  const bankNote = el('p', { class: 'placeholder', text: '出題中は選べません（判定を終えるか、取り消してください）' })
  // 選んだ時点ではまだ配信されない、という点だけ伝える（選び方は見れば分かる）
  const bankHint = el('p', { class: 'placeholder', text: '選んでも、まだ回答者には出ません（出題は「全員に出題」）' })

  // プレースホルダは実際のタブ区切りの記入例（説明より見た方が早い）。中身は形式で切り替える
  const bankPaste = el('textarea', { class: 'input bank-paste', rows: '3' })

  // 形式ごとの列の並び・記入例・AI への依頼文。
  // 形式は貼り付ける人が選ぶ（中身から推測すると、答えが「○」の早押し問題を
  // ○×として取り込んでしまうなどの誤判定が避けられない）
  const PASTE_FORMATS = {
    buzzer: {
      columns: '問題 → 答え → メモ',
      sample: '日本の首都は？\t東京\n富士山の高さは？\t3776m\tm単位で',
      prompt:
        'クイズを20問作ってください。1行1問、タブ区切りで「問題→答え→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
    ox: {
      columns: '問題 → ○ か × → メモ',
      sample: 'カンガルーは後ろ向きに歩けない\t○\n万里の長城は宇宙から見える\t×\t有名な俗説',
      prompt:
        '○×クイズを20問作ってください。1行1問、タブ区切りで「問題→正解（○か×）→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
    choice4: {
      columns: '問題 → 選択肢1〜4 → 正解番号 → メモ',
      sample: '日本の都道府県は？\t43\t45\t47\t49\t3\n五大陸で最大は？\tアフリカ\tユーラシア\t北米\t南米\t2',
      prompt:
        '4択クイズを20問作ってください。1行1問、タブ区切りで' +
        '「問題→選択肢1→選択肢2→選択肢3→選択肢4→正解番号（1〜4）→補足メモ」の順に出力してください。' +
        '前置き・番号・見出しは不要です。',
    },
  }

  const pasteTypeSelect = el('select', { class: 'input paste-type-select' },
    QUESTION_TYPES.map((t) => el('option', { value: t, text: TYPE_LABEL[t] })))
  const pasteColumns = el('p', { class: 'io-columns-line', text: '' })
  const PROMPT_LABEL = '📋 プロンプト例'
  const promptBtn = el('button', { class: 'btn btn-mini', title: 'プロンプト例をコピー', text: PROMPT_LABEL, onclick: async () => {
    const { prompt } = PASTE_FORMATS[pasteTypeSelect.value]
    try {
      await navigator.clipboard.writeText(prompt)
      promptBtn.textContent = '✓ コピー'
    } catch {
      // クリップボードが使えない環境では、貼り付け欄に出して手動コピーしてもらう
      bankPaste.value = prompt
      promptBtn.textContent = '下に出しました'
    }
    setTimeout(() => {
      promptBtn.textContent = PROMPT_LABEL
    }, 1600)
  } })

  // 選んだ形式に合わせて、列の並びと記入例を切り替える
  function syncPasteFormat() {
    const format = PASTE_FORMATS[pasteTypeSelect.value]
    pasteColumns.textContent = format.columns
    bankPaste.placeholder = format.sample
  }
  pasteTypeSelect.addEventListener('change', syncPasteFormat)

  // 取り込み結果は一時表示のトーストで知らせる（画面に残し続けない）
  function reportImport({ added, skipped }) {
    const skip = skipped > 0 ? `（重複など ${skipped}問は取り込まず）` : ''
    showToast(
      added > 0 ? `${added}問を追加しました${skip}` : `追加できる問題がありませんでした${skip}`,
      added > 0 ? 'ok' : 'ng',
    )
    saveBank(items)
    render()
  }

  const bankImportBtn = el('button', { class: 'btn btn-small btn-primary', text: '貼り付けから追加', onclick: () => {
    const result = importTsv(items, bankPaste.value, pasteTypeSelect.value)
    if (result.added > 0) bankPaste.value = ''
    reportImport(result)
  } })

  // お試し用のサンプル問題（同じ問題は重複して入らない）
  const sampleBtn = el('button', { class: 'btn btn-small', text: `お試し用の問題${SAMPLE_QUESTIONS.length}問`, onclick: () => {
    let added = 0
    let skipped = 0
    for (const sample of SAMPLE_QUESTIONS) {
      if (addQuestion(items, sample) !== null) added += 1
      else skipped += 1
    }
    reportImport({ added, skipped })
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
    // 入れ替えは元に戻せないので、実行前に確認する
    if (replaceCheck.checked) {
      const ok = window.confirm(`いまの問題集（${items.length}問）をすべて消して、ファイルの内容に入れ替えます。よろしいですか？`)
      if (!ok) return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const questions = parseImport(String(reader.result))
      if (questions === null) {
        showToast('読み込めませんでした（書き出したファイルを選んでください）', 'ng')
        return
      }
      reportImport(applyImport(items, questions, { replace: replaceCheck.checked }))
    }
    reader.readAsText(file)
  })
  const importLabel = el('label', { class: 'btn btn-small' }, [
    el('span', { text: 'ファイルを読み込む' }),
    importFileInput,
  ])

  function render() {
    const filter = { type: filterType.value, text: filterText.value }
    const filtering = filter.type !== '' || filter.text.trim() !== ''
    const shown = filterQuestions(items, filter)
    // 見えない問題は操作させない（絞り込みで一覧から外れた場合）
    if (selectedId !== null && !shown.some((item) => item.id === selectedId)) selectedId = null

    // 絞り込み欄は問題があるときだけ出す（空の問題集では邪魔になる）
    filterRow.style.display = items.length === 0 ? 'none' : ''
    filterStatus.style.display = filtering ? '' : 'none'
    filterCount.textContent = `${shown.length}問 / 全${items.length}問`
    bankPlaceholder.style.display = items.length === 0 ? '' : 'none'
    bankNoMatch.style.display = items.length > 0 && shown.length === 0 ? '' : 'none'

    bankNote.style.display = onAsk !== null && !canAsk() ? '' : 'none'
    // 行そのものが選択ボタン。1問への操作は下部のバーにまとめる
    // （問題ごとにボタンを並べると、ボタンの方が一覧の主役になってしまう）
    bankRows.replaceChildren(
      ...shown.map((item) => {
        const answer = answerLabel(item.type, item.a, item.choices)
        const selected = item.id === selectedId
        return el('button', {
          class: `bank-row${selected ? ' selected' : ''}${item.id === editingId ? ' editing' : ''}`,
          'aria-pressed': String(selected),
          onclick: () => pickRow(item),
        }, [
          // 未選択でも幅を取り、選んだときに行の中身が動かないようにする
          el('span', { class: 'bank-check', text: '✓' }),
          el('span', { class: 'bank-main' }, [
            el('span', { class: 'bank-head' }, [
              el('span', { class: `type-badge type-${item.type}`, text: TYPE_LABEL[item.type] }),
              el('span', { class: 'bank-q', text: item.q }),
            ]),
            el('span', { class: 'bank-meta', text: `${answer !== '' ? `答え: ${answer} · ` : ''}${formatAskedMeta(item)}` }),
          ]),
        ])
      }),
    )
    renderSelection()
    const exportedAt = getExportedAt()
    exportNote.textContent = exportedAt !== null ? `前回の書き出し: ${new Date(exportedAt).toLocaleString()}` : ''
  }

  function pickRow(item) {
    // 選択中の行をもう一度押したら、そのまま決定（慣れれば行の上だけで完結する）
    if (item.id === selectedId && onAsk !== null) {
      askSelected()
      return
    }
    selectedId = item.id
    render()
  }

  function askSelected() {
    const item = items.find((i) => i.id === selectedId)
    if (item === undefined || onAsk === null || !canAsk()) return
    selectedId = null
    render()
    onAsk(item) // 出題欄への読み込みとポップアップを閉じるのは呼び出し側
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

  // 選んだ1問への操作。「問題を追加」と同じ場所に差し替えで出す（下部を2段にしない）
  const selQ = el('span', { class: 'sel-q', text: '' })
  const selAskBtn = onAsk !== null
    ? el('button', { class: 'btn btn-primary sel-ask', text: 'これにする', onclick: () => askSelected() })
    : null
  const selectionBar = el('div', { class: `card bank-selection${selAskBtn === null ? ' no-ask' : ''}` }, [
    el('div', { class: 'sel-head' }, [
      selQ,
      el('button', { class: 'sel-clear', title: '選択を解除', text: '×', onclick: () => {
        selectedId = null
        render()
      } }),
    ]),
    el('div', { class: 'sel-actions' }, [
      el('button', { class: 'btn btn-small', text: '編集', onclick: () => {
        const item = items.find((i) => i.id === selectedId)
        if (item !== undefined) startEdit(item)
      } }),
      el('button', { class: 'btn btn-small btn-ng', text: '削除', onclick: () => {
        const item = items.find((i) => i.id === selectedId)
        if (item === undefined) return
        // 選んでから消す形なので、取り違えたまま実行しないよう確認する
        if (!window.confirm(`「${item.q}」を削除します。よろしいですか？`)) return
        removeQuestion(items, item.id)
        saveBank(items)
        selectedId = null
        if (editingId === item.id) resetForm()
        else render()
      } }),
      ...(selAskBtn !== null ? [selAskBtn] : []),
    ]),
  ])

  // 選択中はフォームの代わりに操作バーを出す（フォームを開いている間はフォーム優先）
  function renderSelection() {
    const item = selectedId !== null ? items.find((i) => i.id === selectedId) : undefined
    const showBar = item !== undefined && !formCard.classList.contains('open')
    selectionBar.style.display = showBar ? '' : 'none'
    formCard.style.display = showBar ? 'none' : ''
    if (item !== undefined) selQ.textContent = item.q
    if (selAskBtn !== null) selAskBtn.disabled = !canAsk()
  }

  function setFormOpen(open) {
    formCard.classList.toggle('open', open)
    formToggle.setAttribute('aria-expanded', String(open))
    renderSelection() // 開閉に合わせて、下部をフォームと操作バーで入れ替える
  }
  formToggle.addEventListener('click', () => setFormOpen(!formCard.classList.contains('open')))
  // 開いたままだと一覧や取り込みの操作を覆ってしまうため、フォームの外をタップしたら閉じる。
  // フォーム内のクリックはここで止める（要素が作り直されても誤判定しないように）
  formCard.addEventListener('click', (ev) => ev.stopPropagation())
  selectionBar.addEventListener('click', (ev) => ev.stopPropagation())
  document.addEventListener('click', () => setFormOpen(false))

  // 「まとめて入れる」と「ファイルで持ち運ぶ」は目的が違うので節を分ける。
  // 一覧の枠に混ぜず、独立したポップアップとして重ねて表示する
  const ioOverlay = popupOverlay(
    'io-overlay',
    el('div', { class: 'card rules-card bank-io' }, [
      el('h2', { text: 'まとめて入れる・持ち出す' }),
      el('section', { class: 'io-section' }, [
        el('h3', { class: 'io-title', text: '貼り付けて取り込む（1行1問・タブ区切り）' }),
        el('div', { class: 'settings-row' }, [el('span', { text: '形式' }), pasteTypeSelect]),
        // 列の並びと、その形式で作らせるプロンプトは対で使うので横に並べる
        el('div', { class: 'io-columns-row' }, [pasteColumns, promptBtn]),
        bankPaste,
        el('div', { class: 'btn-row' }, [bankImportBtn]),
      ]),
      el('section', { class: 'io-section' }, [
        el('h3', { class: 'io-title', text: 'バックアップ・引っ越し' }),
        exportNote,
        el('div', { class: 'btn-row' }, [exportBtn, importLabel]),
        el('label', { class: 'settings-row io-replace' }, [
          el('span', { text: '読み込む前に、いまの問題集を空にする' }),
          replaceCheck,
        ]),
      ]),
      // お試し用。普段の操作では使わないので末尾に置く
      el('section', { class: 'io-section io-sample' }, [sampleBtn]),
    ]),
  )
  backdropDismiss(ioOverlay)
  const ioBtn = el('button', {
    class: 'link-btn',
    text: 'まとめて入れる・持ち出す',
    onclick: () => ioOverlay.classList.remove('hidden'),
  })

  const listCard = el('div', { class: 'card rules-card bank-card' }, [
    // 見出しと絞り込みは、一覧を下までスクロールしても届くよう上部に貼り付ける
    el('div', { class: 'bank-sticky' }, [
      // 見出しの右端に入口を置く（一覧の中に節を挟まない）
      el('div', { class: 'bank-head-row' }, [el('h2', { text: '問題集' }), ioBtn]),
      filterRow,
      filterStatus,
    ]),
    bankNote,
    ...(onAsk !== null ? [bankHint] : []),
    bankPlaceholder,
    bankNoMatch,
    bankRows,
  ])
  const root = el('div', { class: 'bank-panel' }, [listCard, formCard, selectionBar])

  syncPasteFormat()
  render()
  // ioOverlay は呼び出し側で画面に配置する（問題集の上に重ねるため）
  return { root, ioOverlay, render }
}
