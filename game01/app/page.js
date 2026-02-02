"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

// =======================
// CONFIG
// =======================
const BASE_CHAIN_ID = 8453;
const CONTRACT_ADDRESS = "0x622678862992c0A2414b536Bc4B8B391602BCf";

// 1) Имя write-функции в контракте (если не "play" — поменяй ОДНО слово)
const WRITE_METHOD = "play";

// 2) Порядок аргументов (у тебя событие было score, guess — поэтому true)
const SEND_SCORE_FIRST = true;

// 3) Газ фиксируем (чтобы кошелёк не делал estimateGas)
const GAS_HEX = "0x249F0"; // 150000

// ABI: только write-функция на 2 uint256
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

function formatErr(e) {
  if (!e) return "Unknown error";
  const msg = e?.shortMessage || e?.message || String(e);
  const code = e?.code ? ` | code=${e.code}` : "";
  return `${msg}${code}`;
}

function toHexChainId(dec) {
  // 8453 => 0x2105
  return "0x" + Number(dec).toString(16);
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

  // Last win
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

  // Base App mini-app ready (не ломаем)
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window?.sdk?.actions?.ready) {
        window.sdk.actions.ready();
      }
    } catch {}
  }, []);

  // подписки на смену аккаунта/сети
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

  // =======================
  // Connect (только если не подключен)
  // =======================
  async function connectWallet() {
    try {
      setErr("");
      setDiag("");

      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");

      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const a = accounts?.[0];
      if (!a) throw new Error("Кошелёк не вернул аккаунт");

      setAddr(a);

      const hex = await window.ethereum.request({ method: "eth_chainId" });
      const id = parseInt(hex, 16);
      setChainId(id);

      setDiag(`Подключено: ${shortAddr(a)} | chainId=${id}`);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  // =======================
  // Game
  // =======================
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
  // Save onchain — КЛЮЧЕВОЙ ФИКС
  //  - НЕ ethers provider/signer
  //  - только window.ethereum.request("eth_sendTransaction")
  // =======================
  async function saveOnchain() {
    try {
      setErr("");
      setDiag("Готовлю транзакцию…");

      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");
      if (!addr) throw new Error("Сначала подключи кошелёк");
      if (lastWinGuess == null || lastWinScore == null) throw new Error("Нет победы для сохранения (сначала выиграй раунд)");

      // Проверяем сеть (без автопереключения — никаких лишних pop-up)
      const hex = await window.ethereum.request({ method: "eth_chainId" });
      const id = parseInt(hex, 16);
      setChainId(id);

      if (id !== BASE_CHAIN_ID) {
        throw new Error(`Нужна сеть Base Mainnet (8453). Сейчас: ${id}. Переключи сеть в кошельке и повтори.`);
      }

      // Кодируем calldata вручную
      const iface = new ethers.Interface(ABI);

      const score = BigInt(lastWinScore);
      const g = BigInt(lastWinGuess);

      const a = SEND_SCORE_FIRST ? score : g;
      const b = SEND_SCORE_FIRST ? g : score;

      const data = iface.encodeFunctionData(WRITE_METHOD, [a, b]);

      // Просим кошелек показать транзу
      setDiag("Ожидай окно кошелька (подпись транзакции)…");

      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: addr,
            to: CONTRACT_ADDRESS,
            data,
            gas: GAS_HEX,
            value: "0x0",
            chainId: toHexChainId(BASE_CHAIN_ID),
          },
        ],
      });

      setSavedTx(txHash);
      setDiag(`TX отправлена: ${txHash}`);
    } catch (e) {
      setErr(formatErr(e));
      setDiag("");
    }
  }

  return (
    <div style={{ minHeight: "100vh", padding: 14, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <h2 style={{ margin: "6px 0 10px" }}>BaseUp — Guess BTC (k)</h2>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 800 }}>
              {connected ? shortAddr(addr) : "Кошелёк не подключен"}
            </div>

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
