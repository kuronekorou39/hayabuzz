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
} from '../game/question-bank.js'
import { SAMPLE_QUESTIONS } from '../game/sample-questions.js'
import { el } from '../util/dom.js'

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

  const bankAddBtn = el('button', { class: 'btn btn-primary btn-small', text: '追加', onclick: () => {
    const type = bankTypeSelect.value
    const { raw, choices } = bankFields.read(type)
    const item = addQuestion(items, { type, q: bankQInput.value, a: raw, choices, memo: bankMemoInput.value })
    if (item === null) return
    saveBank(items)
    bankQInput.value = ''
    bankMemoInput.value = ''
    bankFields.clear()
    render()
    bankQInput.focus()
  } })

  const bankRows = el('div', { class: 'bank-rows' })
  const bankPlaceholder = el('p', { class: 'placeholder', text: 'まだ問題がありません。下で追加するか、貼り付け取り込みが使えます。' })
  const bankNote = el('p', { class: 'placeholder', text: '出題中は選べません（判定を終えるか、取り消してください）' })
  const bankHint = el('p', { class: 'placeholder', text: '「選ぶ」を押すと出題欄に読み込みます（出題は「問題を表示」で）' })

  const bankPaste = el('textarea', {
    class: 'input bank-paste',
    rows: '3',
    placeholder:
      '1行1問・タブ区切りで貼り付け（表計算からのコピペでOK）\n' +
      '早押し: 問題／答え／メモ\n' +
      '○×: 問題／○ か ×／メモ\n' +
      '4択: 問題／選択肢1〜4／正解番号／メモ',
  })
  // 取り込み結果の案内（追加数と、重複などで飛ばした数）
  const importNote = el('p', { class: 'placeholder import-note', text: '' })
  function reportImport({ added, skipped }) {
    const skip = skipped > 0 ? `（重複など ${skipped}問は取り込まず）` : ''
    importNote.textContent = added > 0 ? `${added}問を取り込みました${skip}` : `取り込める問題がありませんでした${skip}`
    saveBank(items)
    render()
  }

  const bankImportBtn = el('button', { class: 'btn btn-small', text: '取り込み', onclick: () => {
    const result = importTsv(items, bankPaste.value)
    if (result.added > 0) bankPaste.value = ''
    reportImport(result)
  } })

  // お試し用のサンプル問題（同じ問題は重複して入らない）
  const sampleBtn = el('button', { class: 'btn btn-small', text: 'サンプルを取り込む', onclick: () => {
    let added = 0
    let skipped = 0
    for (const sample of SAMPLE_QUESTIONS) {
      if (addQuestion(items, sample) !== null) added += 1
      else skipped += 1
    }
    reportImport({ added, skipped })
  } })

  const exportNote = el('p', { class: 'placeholder', text: '' })
  const exportBtn = el('button', { class: 'btn btn-small', text: 'ファイルへエクスポート', onclick: () => {
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
        importNote.textContent = '読み込めませんでした（エクスポートしたファイルを指定してください）'
        return
      }
      reportImport(applyImport(items, questions, { replace: replaceCheck.checked }))
    }
    reader.readAsText(file)
  })
  const importLabel = el('label', { class: 'btn btn-small' }, [
    el('span', { text: 'ファイルから復元' }),
    importFileInput,
  ])

  function render() {
    bankPlaceholder.style.display = items.length === 0 ? '' : 'none'
    const askable = onAsk !== null && canAsk()
    bankNote.style.display = onAsk !== null && !askable ? '' : 'none'
    bankRows.replaceChildren(
      ...items.map((item) => {
        const answer = answerLabel(item.type, item.a, item.choices)
        return el('div', { class: 'bank-row' }, [
          el('div', { class: 'bank-main' }, [
            el('div', { class: 'bank-head' }, [
              el('span', { class: `type-badge type-${item.type}`, text: TYPE_LABEL[item.type] }),
              el('span', { class: 'bank-q', text: item.q }),
            ]),
            el('span', { class: 'bank-meta', text: `${answer !== '' ? `答え: ${answer} · ` : ''}${formatAskedMeta(item)}` }),
          ]),
          el('div', { class: 'bank-actions' }, [
            // 編集専用ページでは出題できないのでボタン自体を出さない。
            // 押すと出題欄に読み込むだけで、出題は「問題を表示」で行う
            ...(onAsk !== null
              ? [el('button', { class: 'btn btn-mini', text: '選ぶ', disabled: !askable, onclick: () => onAsk(item) })]
              : []),
            el('button', { class: 'btn btn-mini btn-ng', text: '削除', onclick: () => {
              removeQuestion(items, item.id)
              saveBank(items)
              render()
            } }),
          ]),
        ])
      }),
    )
    const exportedAt = getExportedAt()
    exportNote.textContent =
      exportedAt !== null
        ? `最終エクスポート: ${new Date(exportedAt).toLocaleString()}（ブラウザ保存は消えることがあるため、定期的なエクスポートを推奨）`
        : 'ブラウザ保存は消えることがあります。作ったらエクスポートしてファイルを正本にしてください'
  }

  // 一覧を主役にし、追加フォームと取り込み・書き出しは折りたたんでおく
  const root = el('div', { class: 'card rules-card bank-card' }, [
    el('h2', { text: '問題集' }),
    bankNote,
    ...(onAsk !== null ? [bankHint] : []),
    bankPlaceholder,
    bankRows,
    el('details', { class: 'rules-advanced' }, [
      el('summary', { text: '問題を追加' }),
      el('div', { class: 'bank-add' }, [
        el('div', { class: 'settings-row' }, [el('span', { text: '形式' }), bankTypeSelect]),
        bankQInput,
        bankFields.row,
        bankMemoInput,
        bankAddBtn,
      ]),
    ]),
    el('details', { class: 'rules-advanced' }, [
      el('summary', { text: '取り込み・書き出し' }),
      bankPaste,
      el('div', { class: 'btn-row' }, [bankImportBtn, sampleBtn]),
      el('label', { class: 'settings-row' }, [
        el('span', { text: 'ファイルから復元するとき、今の問題集を空にして入れ替える' }),
        replaceCheck,
      ]),
      el('div', { class: 'btn-row' }, [exportBtn, importLabel]),
      importNote,
      exportNote,
    ]),
  ])

  render()
  return { root, render }
}
