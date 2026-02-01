"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";

// Base Mainnet
const CHAIN_ID_DEC = 8453;
const CHAIN_ID_HEX = "0x2105";

// Public RPC (можешь заменить на свой, но сначала оставь так)
const BASE_RPC = "https://mainnet.base.org";

// ENS Registry address (часто одинаковый на EVM сетях для ENS-совместимых систем)
// Если твой RPC не поддерживает ENS lookup, lookupAddress вернёт null — это не краш.
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const xi = Math.trunc(x);
  if (xi < min || xi > max) return null;
  return xi;
}

export default function Page() {
  const [mounted, setMounted] = useState(false);

  const [walletAddr, setWalletAddr] = useState("");
  const [displayName, setDisplayName] = useState(""); // basename или пусто
  const [status, setStatus] = useState("Не подключено");
  const [chainId, setChainId] = useState(null);
  const [err, setErr] = useState("");

  // game state
  const [guess, setGuess] = useState("");
  const [hint, setHint] = useState("-");
  const [tries, setTries] = useState(0);
  const [wins, setWins] = useState(0);
  const [rounds, setRounds] = useState(0);
  const [pointsLastWin, setPointsLastWin] = useState(0);

  const [targetK, setTargetK] = useState(null);
  const maxTries = 7;
  const minK = 60;
  const maxK = 120;

  const canPlay = useMemo(() => {
    return targetK !== null && tries < maxTries;
  }, [targetK, tries]);

  useEffect(() => setMounted(true), []);

  // RPC provider (для ENS lookup)
  const baseProvider = useMemo(() => {
    try {
      // ethers v6: JsonRpcProvider(url, network)
      return new ethers.JsonRpcProvider(BASE_RPC, {
        name: "base",
        chainId: CHAIN_ID_DEC,
        ensAddress: ENS_REGISTRY,
      });
    } catch {
      return null;
    }
  }, []);

  async function safeGetChainId() {
    try {
      if (!window.ethereum) return null;
      const cid = await window.ethereum.request({ method: "eth_chainId" });
      return cid;
    } catch {
      return null;
    }
  }

  async function ensureBaseNetwork() {
    if (!window.ethereum) return;
    const current = await safeGetChainId();
    setChainId(current);

    if (current === CHAIN_ID_HEX) return;

    // пробуем switch
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CHAIN_ID_HEX }],
      });
      const after = await safeGetChainId();
      setChainId(after);
      return;
    } catch (e) {
      // если сети нет — добавляем
      if (e && e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: CHAIN_ID_HEX,
              chainName: "Base",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [BASE_RPC],
              blockExplorerUrls: ["https://basescan.org"],
            },
          ],
        });
        const after = await safeGetChainId();
        setChainId(after);
        return;
      }
      throw e;
    }
  }

  async function resolveBaseName(address) {
    // 1) пробуем ENS lookup через Base RPC
    try {
      if (!baseProvider) return "";
      const name = await baseProvider.lookupAddress(address);
      if (name && typeof name === "string") return name;
    } catch {
      // игнор — пойдём дальше
    }
    return "";
  }

  async function connect() {
    setErr("");
    try {
      if (!window.ethereum) {
        setErr("Нет window.ethereum (кошелёк/встроенный браузер). Открой в Base App/кошельке.");
        return;
      }

      await ensureBaseNetwork();

      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });

      const addr = accounts?.[0] || "";
      setWalletAddr(addr);
      setStatus(addr ? "Подключено" : "Не подключено");

      if (addr) {
        const name = await resolveBaseName(addr);
        setDisplayName(name);
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  // слушаем смену аккаунта/сети
  useEffect(() => {
    if (!mounted) return;
    if (!window.ethereum) return;

    const onAccounts = async (accs) => {
      const addr = accs?.[0] || "";
      setWalletAddr(addr);
      setStatus(addr ? "Подключено" : "Не подключено");
      setDisplayName("");
      if (addr) {
        const name = await resolveBaseName(addr);
        setDisplayName(name);
      }
    };

    const onChain = async () => {
      const cid = await safeGetChainId();
      setChainId(cid);
      // если сеть не Base — просто покажем
    };

    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);

    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  function newRound() {
    setErr("");
    const rnd = Math.floor(Math.random() * (maxK - minK + 1)) + minK; // 60..120
    setTargetK(rnd);
    setTries(0);
    setHint("-");
    setGuess("");
    setRounds((v) => v + 1);
    setPointsLastWin(0);
  }

  function check() {
    setErr("");
    if (targetK === null) {
      setErr("Нажми «Новый раунд».");
      return;
    }
    if (tries >= maxTries) {
      setErr("Попытки закончились. Нажми «Новый раунд».");
      return;
    }

    const g = clampInt(guess, minK, maxK);
    if (g === null) {
      setErr(`Введи число ${minK}..${maxK}`);
      return;
    }

    const nextTries = tries + 1;
    setTries(nextTries);

    if (g === targetK) {
      // простая система очков: чем меньше попыток — тем больше
      const pts = (maxTries - (nextTries - 1)) * 10; // 70..10
      setWins((v) => v + 1);
      setHint(`✅ Угадал! Было ${targetK}k. +${pts} очков`);
      setPointsLastWin(pts);
      return;
    }

    if (g < targetK) setHint("⬆️ Выше");
    if (g > targetK) setHint("⬇️ Ниже");

    if (nextTries >= maxTries) {
      setHint(`❌ Не угадал. Было ${targetK}k. Нажми «Новый раунд».`);
    }
  }

  const headerName = displayName ? displayName : (walletAddr ? shortAddr(walletAddr) : "—");

  // UI
  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 16,
        background: "linear-gradient(135deg, #0b63ff 0%, #ffffff 45%, #0b63ff 100%)",
      }}
    >
      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          background: "rgba(255,255,255,0.88)",
          borderRadius: 16,
          padding: 16,
          boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 22 }}>
          Mini App: BTC Guess (Base Mainnet)
        </h2>

        <div style={{ marginTop: 8, opacity: 0.85 }}>
          Допустимые уровни: <b>{minK}k</b> … <b>{maxK}k</b>
        </div>
        <div style={{ marginTop: 6, opacity: 0.85 }}>
          Вводи число <b>{minK}..{maxK}</b> (например: 69 = 69k = $69,000). Попыток на раунд: <b>{maxTries}</b>
        </div>

        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 14,
            border: "1px solid rgba(0,0,0,0.08)",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              background: "#e9eefc",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              color: "#0b63ff",
            }}
          >
            B
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{headerName}</div>
            <div style={{ opacity: 0.8 }}>Статус: {status}</div>
            <div style={{ opacity: 0.8 }}>ChainId: {chainId || "—"} (нужен {CHAIN_ID_DEC})</div>
          </div>

          <button
            onClick={connect}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.15)",
              background: "#0b63ff",
              color: "white",
              fontWeight: 700,
            }}
          >
            Connect
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
          {walletAddr ? (
            <>
              Адрес: <code>{walletAddr}</code>
              <br />
              Base Name: <b>{displayName || "не найден (lookup вернул null)"}</b>
            </>
          ) : (
            "Подключи кошелёк, чтобы показать адрес и Base Name."
          )}
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={newRound}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.15)",
              background: "white",
              fontWeight: 700,
            }}
          >
            Новый раунд
          </button>

          <button
            onClick={() => {}}
            disabled
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.10)",
              background: "#f2f2f2",
              fontWeight: 700,
              opacity: 0.7,
            }}
          >
            Сохранить результат (onchain)
          </button>

          <button
            onClick={() => {}}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.15)",
              background: "white",
              fontWeight: 700,
            }}
          >
            Обновить лидерборд
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Угадай уровень BTC (k): введи {minK}…{maxK}</div>

          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <input
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="например 69"
              inputMode="numeric"
              style={{
                flex: 1,
                padding: "12px 12px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.2)",
                fontSize: 16,
              }}
            />
            <button
              onClick={check}
              disabled={!canPlay}
              style={{
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.15)",
                background: canPlay ? "#0b63ff" : "#cfd8ff",
                color: "white",
                fontWeight: 800,
              }}
            >
              Проверить
            </button>
          </div>

          <div style={{ marginTop: 8, opacity: 0.7 }}>Введите число (2–3 цифры)</div>

          <div style={{ marginTop: 12 }}>
            <div><b>Подсказка:</b> {hint}</div>
            <div style={{ marginTop: 8, opacity: 0.9 }}>
              Попыток (в этом раунде): <b>{tries}</b> / <b>{maxTries}</b>
              <br />
              Раунды: <b>{rounds}</b>
              <br />
              Победы: <b>{wins}</b>
              <br />
              Очки за последнюю победу: <b>{pointsLastWin}</b>
            </div>
          </div>

          {err ? (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                borderRadius: 12,
                background: "rgba(255,0,0,0.07)",
                border: "1px solid rgba(255,0,0,0.20)",
                color: "#8a0000",
                fontWeight: 700,
                whiteSpace: "pre-wrap",
              }}
            >
              {err}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
