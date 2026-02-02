"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

// =======================
// CONFIG
// =======================
const BASE_CHAIN_ID = 8453;
const CONTRACT_ADDRESS = "0x622678862992c0A2414b536Bc4B8B391602BCf";

// ВАЖНО: имя write-функции в контракте.
// Если у тебя другое — поменяй ТОЛЬКО ЭТО на 1 слово.
const WRITE_METHOD = "play";

// ВАЖНО: порядок аргументов в write-функции:
// true  => (score, guess)
// false => (guess, score)
const SEND_SCORE_FIRST = true;

// Минимальный ABI: write функция (2x uint256). Событие не нужно для отправки tx.
const ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "a", type: "uint256" },
      { internalType: "uint256", name: "b", type: "uint256" },
    ],
    name: WRITE_METHOD,
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// =======================
// Utils
// =======================
function clampInt(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const y = Math.trunc(x);
  if (y < lo || y > hi) return null;
  return y;
}

function randomInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shortAddr(a) {
  if (!a || typeof a !== "string") return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function formatEthersErr(e) {
  // максимально информативно, но коротко
  const short = e?.shortMessage;
  const msg = e?.message;
  const code = e?.code ? ` | code=${e.code}` : "";
  const reason = e?.reason ? ` | reason=${e.reason}` : "";
  if (short) return `${short}${code}${reason}`;
  if (msg) return `${msg}${code}${reason}`;
  return String(e);
}

// =======================
// Page
// =======================
export default function Page() {
  // Wallet
  const [addr, setAddr] = useState("");
  const [chainId, setChainId] = useState(null);

  // Game
  const [secretK, setSecretK] = useState(() => randomInt(60, 120));
  const [guess, setGuess] = useState("");
  const [hint, setHint] = useState("-");
  const [tries, setTries] = useState(0);
  const [rounds, setRounds] = useState(1);
  const [wins, setWins] = useState(0);

  // Win info
  const [lastWinGuess, setLastWinGuess] = useState(null);
  const [lastWinScore, setLastWinScore] = useState(null);
  const [savedTx, setSavedTx] = useState("-");

  // Status
  const [diag, setDiag] = useState("");
  const [err, setErr] = useState("");

  const attemptsMax = 7;

  const connected = !!addr;

  const lastWinBlock = useMemo(() => {
    const g = lastWinGuess == null ? "-" : `${lastWinGuess}k`;
    const s = lastWinScore == null ? "-" : `${lastWinScore}`;
    return { g, s };
  }, [lastWinGuess, lastWinScore]);

  // Base App mini-app ready (не ломаем если нет sdk)
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window?.sdk?.actions?.ready) {
        window.sdk.actions.ready();
      }
    } catch {}
  }, []);

  // listen account/chain changes
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;

    const onAccountsChanged = (accounts) => {
      const a = accounts?.[0] || "";
      setAddr(a);
      setSavedTx("-");
      setErr("");
      setDiag("");
    };

    const onChainChanged = (hex) => {
      const id = parseInt(hex, 16);
      setChainId(id);
      setSavedTx("-");
      setErr("");
      setDiag("");
    };

    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);

    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  // connect (одна кнопка, без "переподключить")
  async function connectWallet() {
    try {
      setErr("");
      setDiag("");

      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");

      const bp = new ethers.BrowserProvider(window.ethereum);
      await bp.send("eth_requestAccounts", []);

      const signer = await bp.getSigner();
      const a = await signer.getAddress();
      setAddr(a);

      const net = await bp.getNetwork();
      setChainId(Number(net.chainId));

      setDiag(`Подключено: ${shortAddr(a)} | chainId=${Number(net.chainId)}`);
    } catch (e) {
      setErr(formatEthersErr(e));
    }
  }

  // game
  function newRound() {
    setErr("");
    setDiag("");
    setHint("-");
    setTries(0);
    setGuess("");
    setSecretK(randomInt(60, 120));
    setRounds((r) => r + 1);
  }

  function checkGuess() {
    setErr("");
    setDiag("");

    const g = clampInt(guess, 60, 120);
    if (g === null) {
      setHint("Введи число 60…120");
      return;
    }

    const nextTries = tries + 1;
    setTries(nextTries);

    if (g === secretK) {
      const score = Math.max(1, attemptsMax + 1 - nextTries); // 7..1
      setHint("✅ Угадал!");
      setWins((w) => w + 1);
      setLastWinGuess(g);
      setLastWinScore(score);
      setSavedTx("-");
      return;
    }

    setHint(g < secretK ? "🔼 Больше" : "🔽 Меньше");

    if (nextTries >= attemptsMax) {
      setHint(`❌ Попытки закончились. Было: ${secretK}`);
    }
  }

  // =======================
  // Save onchain (главный фикс)
  // - НЕ используем contract.method() чтобы ethers не делал estimateGas, который у тебя ломается
  // - отправляем RAW tx через signer.sendTransaction с gasLimit
  // =======================
  async function saveOnchain() {
    try {
      setErr("");
      setDiag("Готовлю транзакцию…");

      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");
      if (!addr) throw new Error("Сначала подключи кошелёк");
      if (lastWinGuess == null || lastWinScore == null) throw new Error("Нет победы для сохранения (сначала выиграй раунд)");

      const bp = new ethers.BrowserProvider(window.ethereum);
      await bp.send("eth_requestAccounts", []);
      const signer = await bp.getSigner();

      // 1) Проверка сети (БЕЗ auto-switch, чтобы не было лишних pop-up)
      const net = await bp.getNetwork();
      const id = Number(net.chainId);
      setChainId(id);

      if (id !== BASE_CHAIN_ID) {
        throw new Error(`Нужна сеть Base Mainnet (8453). Сейчас: ${id}. Переключи сеть в кошельке и повтори.`);
      }

      // 2) Проверка что по адресу реально контракт
      const code = await bp.getCode(CONTRACT_ADDRESS);
      if (!code || code === "0x") {
        throw new Error("По адресу контракта нет bytecode (это не контракт). Проверь CONTRACT_ADDRESS.");
      }

      // 3) Кодируем data вручную (никакого estimateGas)
      const iface = new ethers.Interface(ABI);

      const score = BigInt(lastWinScore);
      const g = BigInt(lastWinGuess);

      const a = SEND_SCORE_FIRST ? score : g;
      const b = SEND_SCORE_FIRST ? g : score;

      const data = iface.encodeFunctionData(WRITE_METHOD, [a, b]);

      // 4) RAW sendTransaction с gasLimit => окно транзы обязано появиться
      setDiag("Ожидай окно кошелька (подпись транзакции)…");
      const tx = await signer.sendTransaction({
        to: CONTRACT_ADDRESS,
        data,
        // фиксируем газ, чтобы НЕ дергать estimateGas (оно у тебя и ломается)
        gasLimit: 150000n,
      });

      setSavedTx(tx.hash);
      setDiag(`TX отправлена: ${tx.hash}`);

      const rc = await tx.wait();
      setSavedTx(rc.hash);
      setDiag(`TX подтверждена: ${rc.hash}`);
    } catch (e) {
      setErr(formatEthersErr(e));
      setDiag("");
    }
  }

  return (
    <div style={{ minHeight: "100vh", padding: 14, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <h2 style={{ margin: "6px 0 10px" }}>BaseUp — Guess BTC (k)</h2>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>{connected ? shortAddr(addr) : "Кошелёк не подключен"}</div>
            {!connected && (
              <button
                onClick={connectWallet}
                style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
              >
                Подключить
              </button>
            )}
          </div>

          <div style={{ marginTop: 8, fontSize: 14 }}>
            <div>ChainId: <b>{chainId ?? "-"}</b></div>
            <div>Контракт: <b>{CONTRACT_ADDRESS}</b></div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <button
              onClick={newRound}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              Новый раунд
            </button>

            <button
              onClick={saveOnchain}
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #bbb",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 800,
              }}
            >
              Сохранить результат (onchain)
            </button>
          </div>
        </div>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Угадай уровень BTC (k): введи 60…120</div>

          <div style={{ display: "flex", gap: 10 }}>
            <input
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="например 69"
              inputMode="numeric"
              style={{ flex: 1, padding: 12, borderRadius: 10, border: "1px solid #bbb" }}
            />
            <button
              onClick={checkGuess}
              style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              Проверить
            </button>
          </div>

          <div style={{ marginTop: 8, opacity: 0.75 }}>Введите число (2–3 цифры)</div>

          <div style={{ marginTop: 10, fontWeight: 700 }}>
            Подсказка: <span style={{ fontWeight: 900 }}>{hint}</span>
          </div>

          <div style={{ marginTop: 10, lineHeight: 1.5 }}>
            <div>Попыток (в этом раунде): <b>{Math.min(tries, attemptsMax)}</b> / <b>{attemptsMax}</b></div>
            <div>Раунды: <b>{rounds}</b></div>
            <div>Победы: <b>{wins}</b></div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 12, background: "#fafafa" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Последняя победа (для onchain):</div>
            <div>guess: <b>{lastWinBlock.g}</b></div>
            <div>score: <b>{lastWinBlock.s}</b></div>
            <div>saved tx: <b>{savedTx}</b></div>
          </div>

          {diag ? <div style={{ marginTop: 12, color: "#0a7a2f", fontWeight: 800 }}>Диагностика: {diag}</div> : null}
          {err ? <div style={{ marginTop: 12, color: "#b00000", fontWeight: 800 }}>Ошибка: {err}</div> : null}
        </div>
      </div>
    </div>
  );
}
