import { ethers } from "ethers";

const RPC = "https://mainnet.base.org";
const ADDRESS = "0x6226788629929Ce0A2414b536Bc4B8B391602BCf";

const provider = new ethers.JsonRpcProvider(RPC);

const code = await provider.getCode(ADDRESS);
console.log("Address:", ADDRESS);
console.log("Code length:", code.length);
console.log("Is contract:", code && code !== "0x");