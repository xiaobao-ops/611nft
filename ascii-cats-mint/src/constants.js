export const CHAIN_ID = 4663;
export const CONTRACT_ADDRESS = '0xa3F56AdB32D3A8F3b41462e3fBF17f36829325bE';
export const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
export const DEFAULT_TICKET_URL = 'https://asciicats.xyz/backend/api/mint-ticket.php';
export const STATE_FILENAME = '.mint-state.json';

export const ABI = Object.freeze([
  'function mintOpen() view returns (bool)',
  'function totalMinted() view returns (uint256)',
  'function hasMinted(address wallet) view returns (bool)',
  'function mintSigner() view returns (address)',
  'function saltUsed(bytes32 salt) view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function mint(bytes32 salt, bytes signature)',
  'event Minted(uint256 indexed id, address indexed to)',
]);
