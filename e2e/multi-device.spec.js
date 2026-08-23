import { devices, expect, test } from '@playwright/test'
import { askAndArm, createRoom, joinPlayer, pressBuzzer } from './helpers.js'

// 全員の buzz を host に届かせる「同時押し」の再現。
// 最初の押下が host に届いて LOCKED が配信されると他 player のボタンは無効化される
// 仕様のため、順番にクリックしたのでは 2 人目以降が間に合わない。
// そこで各ページに「armed になった瞬間に押す」オブザーバを仕込んでから host が
// 受付開始する。armed の配信は因果的に必ず LOCKED より先に各端末へ届くので、
// タイマー精度に依存せず全員分の押下が順位に入る。
function pressWhenArmed(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const buzzer = document.querySelector('.buzzer')
        const tryPress = () => {
          if (!buzzer.classList.contains('armed')) return false
          buzzer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
          resolve()
          return true
        }
        if (tryPress()) return
        const observer = new MutationObserver(() => {
          if (tryPress()) observer.disconnect()
        })
        observer.observe(buzzer, { attributes: true, attributeFilter: ['class'] })
      }),
  )
}

async function raceBuzz(host, players, questionText) {
  const presses = players.map((p) => pressWhenArmed(p.page)) // 先に仕込む（まだ await しない）
  await askAndArm(host, questionText)
  await Promise.all(presses)
  await expect(host.page.locator('.order-row')).toHaveCount(players.length)
}

test('複数端末: 3人参加（1人はスマホ）で押下順・次点・再開放・手動加点', async ({ browser }) => {
  test.setTimeout(360_000)
  const host = await createRoom(browser)

  // 3端末（別コンテキスト=別ストレージ・別セッション）。はなこ はスマホ相当（タッチ入力）
  const p1 = await joinPlayer(browser, host.code, 'たろう')
  const p2 = await joinPlayer(browser, host.code, 'はなこ', { ...devices['iPhone 13'] })
  const p3 = await joinPlayer(browser, host.code, 'じろう')
  const byNick = { たろう: p1, はなこ: p2, じろう: p3 }

  await expect(host.page.locator('.score-row')).toHaveCount(3)

  // --- ほぼ同時押しで 3 人分の押下順が付く ---
  await raceBuzz(host, [p1, p2, p3], '1 + 1 は？')

  // 順位は host 時計換算で決まる（このテストではどの並びかは問わない）
  const nicks = await host.page.locator('.order-nick').allTextContents()
  expect(new Set(nicks)).toEqual(new Set(['たろう', 'はなこ', 'じろう']))
  const first = byNick[nicks[0]]
  const second = byNick[nicks[1]]
  const third = byNick[nicks[2]]

  // ms差は 1位が +0 で昇順
  const deltas = (await host.page.locator('.order-delta').allTextContents()).map((t) => parseFloat(t.slice(1)))
  expect(deltas[0]).toBe(0)
  for (let i = 1; i < deltas.length; i++) {
    expect(deltas[i]).toBeGreaterThanOrEqual(deltas[i - 1])
  }

  // 1位が回答権を持ち、他はロックされて誰が回答中か表示される
  await expect(first.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await expect(second.page.locator('.buzzer-label')).toHaveText(`${first.nick}さんが回答中`)

  // --- 不正解 → 次点者に権利を回す ---
  await host.page.getByRole('button', { name: '不正解→次点へ' }).click()
  await expect(host.page.locator('.order-row', { hasText: nicks[0] }).locator('.badge.ng')).toBeVisible()
  await expect(host.page.locator('.order-row', { hasText: nicks[1] }).locator('.badge.active')).toBeVisible()
  await expect(first.page.locator('.buzzer-label')).toHaveText('誤答のため待機')
  await expect(second.page.locator('.buzzer-label')).toHaveText('回答してください！')

  // --- 不正解 → 全員に再開放（誤答者2人は除外されたまま） ---
  await host.page.getByRole('button', { name: '不正解→全員再開放' }).click()
  await expect(first.page.locator('.buzzer-label')).toHaveText('誤答のため待機')
  await expect(second.page.locator('.buzzer-label')).toHaveText('誤答のため待機')
  await expect(third.page.locator('.buzzer')).toHaveClass(/\barmed\b/)

  await pressBuzzer(third.page)
  await expect(third.page.locator('.buzzer-label')).toHaveText('回答してください！')

  // --- 正解 → 全端末に結果（トースト）と得点が配信される ---
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(third.page.locator('.toast.ok', { hasText: '正解！ +1点' })).toBeVisible()
  await expect(first.page.locator('.toast.ok', { hasText: `${third.nick} さんが正解` })).toBeVisible()
  await expect(second.page.locator('.toast.ok', { hasText: `${third.nick} さんが正解` })).toBeVisible()
  await expect(third.page.locator('.me-summary')).toContainText('1点')

  // --- 手動加減点が該当 player に配信される ---
  await host.page.locator('.score-row', { hasText: first.nick }).getByRole('button', { name: '＋' }).click()
  await expect(first.page.locator('.me-summary')).toContainText('1点')
  await host.page.locator('.score-row', { hasText: first.nick }).getByRole('button', { name: '−' }).click()
  await expect(first.page.locator('.me-summary')).toContainText('0点')

  // --- ルール: ハンデを付けた player は同時押しでも順位が下がる ---
  await host.page.getByRole('button', { name: 'ルール' }).click()
  await host.page.locator('.rules-advanced summary').click() // 折りたたみの詳細設定を開く
  const handicapInput = host.page.locator('.handicap-row', { hasText: 'たろう' }).locator('input')
  await handicapInput.fill('1000')
  await handicapInput.blur()
  await host.page.locator('.rules-overlay').getByRole('button', { name: '閉じる' }).click()
  // ハンデは全端末の得点表に表示される
  await expect(host.page.locator('.score-row', { hasText: 'たろう' })).toContainText('ハンデ+1000ms')
  await p2.page.getByRole('button', { name: '得点表' }).click()
  await expect(p2.page.locator('.board-row', { hasText: 'たろう' })).toContainText('ハンデ+1000ms')
  await p2.page.locator('.board-overlay').getByRole('button', { name: '閉じる' }).click()

  await raceBuzz(host, [p1, p2, p3], 'ハンデ確認')
  const nicksAfter = await host.page.locator('.order-nick').allTextContents()
  expect(nicksAfter[2]).toBe('たろう') // 1秒のハンデで最下位になる
  const deltasAfter = (await host.page.locator('.order-delta').allTextContents()).map((t) => parseFloat(t.slice(1)))
  expect(deltasAfter[2]).toBeGreaterThanOrEqual(900)

  for (const p of [p1, p2, p3]) await p.context.close()
  await host.context.close()
})

test('次点がいない不正解は「正解者なし」で終わる', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  await askAndArm(host, '難問です')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(host.page.locator('.badge.active')).toBeVisible()

  // 押したのが1人だけなので次点がなく、正解者なしの結果になる
  await host.page.getByRole('button', { name: '不正解→次点へ' }).click()
  await expect(p1.page.locator('.toast.ng', { hasText: '正解者なし' })).toBeVisible()

  await p1.context.close()
  await host.context.close()
})
