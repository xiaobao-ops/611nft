// const {
//     Connection,
//     Keypair,
//     PublicKey,
//     sendAndConfirmTransaction,
//     Transaction,
//     TransactionInstruction,
//   } = require("@solana/web3.js");
//   const bs58 = require("bs58");
  
//   export const getKeyPair = (secret: any) => {
//     try {
//       return Keypair.fromSecretKey(bs58.decode(secret));
//     } catch (e: any) {
//       console.log('私钥错误', e.message)
//       return null
//     }
//   }
  
//   export const logMemo = async () => {
//     try {
//       let tx = new Transaction();
//       tx.add(
//         new TransactionInstruction({
//           keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }],
//           data: Buffer.from(
//             `{"p":"src-20","op":"mint","tick":"lamp","amt":"1000"}`,
//             "utf-8"
//           ),
//           programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
//         })
//       );
//       let result = sendAndConfirmTransaction(SOLANA_CONNECTION, tx, [
//         keypair,
//       ]).catch((e) => {
//         console.log("出现错误,脚本已经尝试容错.", e.message);
//       });
//       console.log("complete: ", `https://solscan.io/tx/${await result}`);
//       return result;
//     } catch (e) {
//       console.log("出现错误,脚本已尝试重新操作.", e.message);
//     }
//   };
  
//   var mintCount = 100000;

//   export const main = () => {
//     for (let i = 0; i < 1; i++) {
//       setInterval(() => {
//         try {
//           logMemo();
//         } catch (e) {
//           console.log("出现错误,脚本已尝试重新操作.", e.message);
//         }
//       }, 100);
//     }
//   }
  