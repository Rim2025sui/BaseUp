"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

// =======================
// НАСТРОЙКИ (1 место)
// =======================
const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = "0x2105";
const CONTRACT_ADDRESS = "0x622678862992c0A2414b536Bc4B8B391602BCf";

// ВАЖНО: имя write-функции контракта (поменяешь ТОЛЬКО ЭТО, если у тебя другое имя)
// Примеры: "play", "saveResult", "record", "save"
const WRITE_METHOD = "play";

// ВАЖНО: порядок аргументов в write-функции
// true  => (score, guess)
// false => (guess, score)
const SEND_SCORE_FIRST = true;

// Минимальный ABI: event + write-функция
// Если твой write метод другой, но с теми же 2 uint256 — просто меняешь WRITE_METHOD сверху.
const ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "user", type: "address" },
      { indexed: false, internalType: "uint256", name: "score", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "guess", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "ts", type: "uint256" },
    ],
    name: "GamePlayed",
    type: "event",
  },
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
// Утилиты
// =======================
function clampInt(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const y = Math.trunc(x);
  if (y < lo || y > hi) return null;
  return y;
}

function randomInt(lo, hi) {
  // inclusive
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shortAddr(a) {
  if (!a || typeof a !== "string") return "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function formatEthersErr(e) {
  const short = e?.shortMessage;
  const msg = e?.message;
  const code = e?.code ? ` | code=${e.code}` : "";
  if (short) return `${short}${code}`;
  if (msg) return `${msg}${code}`;
  return String(e);
}

// НЕ ДОЛЖНО ЛОМАТЬ ПРИЛОЖЕНИЕ (ENS может падать на Base)
async function safeLookupBaseName(provider, address) {
  try {
    const name = await provider.lookupAddress(address);
    return name || null;
  } catch {
    return null;
  }
}

// =======================
// UI
// =======================
export default function Page() {
  // Wallet / chain
  const [addr, setAddr] = useState("");
  const [baseName, setBaseName] = useState(null);
  const [chainId, setChainId] = useState(null);

  // Game
  const [secretK, setSecretK] = useState(() => randomInt(60, 120));
  const [guess, setGuess] = useState("");
  const [hint, setHint] = useState("-");
  const [tries, setTries] = useState(0);
  const [rounds, setRounds] = useState(1);
  const [wins, setWins] = useState(0);

  // Scores
  const [lastWinGuess, setLastWinGuess] = useState(null);
  const [lastWinScore, setLastWinScore] = useState(null);
  const [savedTx, setSavedTx] = useState("-");
  const [bestRound, setBestRound] = useState(0);
  const [totalPoints, setTotalPoints] = useState(0);

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

  // =======================
  // Init: Base App ready (не ломаем, если SDK нет)
  // =======================
  useEffect(() => {
    try {
      // иногда в mini-app есть sdk в window
      if (typeof window !== "undefined" && window?.sdk?.actions?.ready) {
        window.sdk.actions.ready();
      }
    } catch {}
  }, []);

  // =======================
  // Подписки на смену аккаунта/сети
  // =======================
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;

    const onAccountsChanged = (accounts) => {
      const a = accounts?.[0] || "";
      setAddr(a);
      setBaseName(null);
      setSavedTx("-");
      setErr("");
      setDiag("");
    };

    const onChainChanged = (hex) => {
      const id = parseInt(hex, 16);
      setChainId(id);
      setBaseName(null);
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
  // Connect
  // =======================
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

      // name pull не ломает app
      const name = await safeLookupBaseName(bp, a);
      setBaseName(name);

      setDiag(`Подключено: ${shortAddr(a)} | chainId=${Number(net.chainId)}`);
    } catch (e) {
      setErr(formatEthersErr(e));
    }
  }

  async function switchToBase() {
    try {
      setErr("");
      setDiag("");
      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID_HEX }],
      });

      // chainChanged сам прилетит, но подстрахуем
      const bp = new ethers.BrowserProvider(window.ethereum);
      const net = await bp.getNetwork();
      setChainId(Number(net.chainId));
      setDiag(`Сеть переключена: chainId=${Number(net.chainId)}`);
    } catch (e) {
      setErr(formatEthersErr(e));
    }
  }

  async function refreshBaseName() {
    try {
      setErr("");
      setDiag("");
      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");
      if (!addr) throw new Error("Сначала подключи кошелёк");

      const bp = new ethers.BrowserProvider(window.ethereum);
      const name = await safeLookupBaseName(bp, addr);
      setBaseName(name);
      setDiag(name ? `Base Name обновлён: ${name}` : "Base Name не найден (скорее всего не выставлен reverse/primary record).");
    } catch (e) {
      setErr(formatEthersErr(e));
    }
  }

  // =======================
  // Game actions
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
      // очки за победу: чем меньше попыток — тем больше
      // 1 попытка => 7 очков, 7 попыток => 1 очко
      const score = Math.max(1, attemptsMax + 1 - nextTries);

      setHint("✅ Угадал!");
      setWins((w) => w + 1);

      setLastWinGuess(g);
      setLastWinScore(score);
      setSavedTx("-");

      setBestRound((best) => Math.max(best, score));
      setTotalPoints((t) => t + score);

      // следующий раунд автоматически (как хочешь — я оставил “Новый раунд” кнопкой)
      return;
    }

    if (g < secretK) setHint("🔼 Больше");
    if (g > secretK) setHint("🔽 Меньше");

    if (nextTries >= attemptsMax) {
      setHint(`❌ Попытки закончились. Было: ${secretK}`);
    }
  }

  // =======================
  // Onchain save
  // =======================
  async function saveOnchain() {
    try {
      setErr("");
      setDiag("Диагностика сети/контракта…");

      if (!window.ethereum) throw new Error("Wallet не найден (нет window.ethereum)");
      if (!addr) throw new Error("Сначала подключи кошелёк");
      if (lastWinGuess == null || lastWinScore == null) throw new Error("Нет победы для сохранения (сначала выиграй раунд)");

      // BrowserProvider -> signer (иначе транзы не будет)
      const bp = new ethers.BrowserProvider(window.ethereum);
      await bp.send("eth_requestAccounts", []);
      const signer = await bp.getSigner();

      const net = await bp.getNetwork();
      const id = Number(net.chainId);
      setChainId(id);

      if (id !== BASE_CHAIN_ID) {
        setDiag(`Нужно Base Mainnet (8453). Сейчас: ${id}. Переключаю…`);
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BASE_CHAIN_ID_HEX }],
        });
      }

      const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

      const score = BigInt(lastWinScore);
      const g = BigInt(lastWinGuess);

      const a = SEND_SCORE_FIRST ? score : g;
      const b = SEND_SCORE_FIRST ? g : score;

      setDiag("Готовлю транзакцию… Ожидай окно кошелька.");
      const tx = await contract[WRITE_METHOD](a, b);
      setDiag(`TX отправлена: ${tx.hash}`);
      setSavedTx(tx.hash);

      const rc = await tx.wait();
      setDiag(`TX подтверждена: ${rc.hash}`);
      setSavedTx(rc.hash);
    } catch (e) {
      setErr(formatEthersErr(e));
      setDiag("");
    }
  }

  // =======================
  // Render
  // =======================
  const baseNameText = baseName ? baseName : "не найден (скорее всего не выставлен reverse/primary record).";

  return (
    <div style={{ minHeight: "100vh", padding: 14, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <h2 style={{ margin: "6px 0 10px" }}>BaseUp — Guess BTC (k)</h2>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700 }}>{connected ? shortAddr(addr) : "Кошелёк не подключен"}</div>
            <button
              onClick={connectWallet}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              {connected ? "Переподключить" : "Подключить"}
            </button>
          </div>

          {connected && (
            <div style={{ marginTop: 8, color: "#333" }}>
              <div style={{ fontSize: 13, opacity: 0.9 }}>Подключено</div>
              <div style={{ fontSize: 13, opacity: 0.9 }}>{addr}</div>

              <div style={{ marginTop: 8, color: "#b00000" }}>
                <div style={{ fontWeight: 700 }}>Base Name:</div>
                <div>{baseNameText}</div>
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Chain / Contract</div>
          <div style={{ fontSize: 14 }}>ChainId: {chainId ?? "-"}</div>
          <div style={{ fontSize: 14 }}>Контракт: {CONTRACT_ADDRESS}</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <button
              onClick={refreshBaseName}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              Обновить Base Name
            </button>

            <button
              onClick={newRound}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              Новый раунд
            </button>

            <button
              onClick={switchToBase}
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #bbb", background: "#fff", cursor: "pointer" }}
            >
              Переключить на Base
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            <button
              onClick={saveOnchain}
              style={{
                width: "100%",
                padding: "12px 12px",
                borderRadius: 10,
                border: "1px solid #bbb",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 700,
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

          <div style={{ marginTop: 10, fontWeight: 700 }}>Подсказка: <span style={{ fontWeight: 800 }}>{hint}</span></div>

          <div style={{ marginTop: 10, lineHeight: 1.5 }}>
            <div>Попыток (в этом раунде): <b>{Math.min(tries, attemptsMax)}</b> / <b>{attemptsMax}</b></div>
            <div>Раунды: <b>{rounds}</b></div>
            <div>Победы: <b>{wins}</b></div>
            <div>Очки за последнюю победу: <b>{lastWinScore ?? "-"}</b></div>
            <div>Лучший результат за раунд: <b>{bestRound}</b></div>
            <div>Суммарные очки (total): <b>{totalPoints}</b></div>
          </div>

          <div style={{ marginTop: 12, padding: 12, border: "1px solid #eee", borderRadius: 12, background: "#fafafa" }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Последняя победа (для onchain):</div>
            <div>guess: <b>{lastWinBlock.g}</b></div>
            <div>score: <b>{lastWinBlock.s}</b></div>
            <div>saved tx: <b>{savedTx}</b></div>
          </div>

          {diag ? (
            <div style={{ marginTop: 12, color: "#0a7a2f", fontWeight: 700 }}>Диагностика: {diag}</div>
          ) : null}

          {err ? (
            <div style={{ marginTop: 12, color: "#b00000", fontWeight: 700 }}>Ошибка: {err}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
