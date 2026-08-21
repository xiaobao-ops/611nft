import { randomUUID } from "node:crypto"
import { createTaskConfirmationStore } from "./task-confirmations.js"
import { buildAdvancedMintTransactions, normalizeAdvancedMintInput } from "./advanced-mint.js"

const GAS_BUFFER_BPS = 13_000n
const BPS_SCALE = 10_000n
const LOG_LIMIT = 500

function serviceError(status, message) {
  return Object.assign(new Error(message), { status })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function bufferedGas(value) {
  const gas = BigInt(value)
  return ((gas * GAS_BUFFER_BPS) + BPS_SCALE - 1n) / BPS_SCALE
}

function bumpedFee(value, multiplier) {
  const fee = BigInt(value)
  const bps = BigInt(Math.ceil(multiplier * Number(BPS_SCALE)))
  const bumped = ((fee * bps) + BPS_SCALE - 1n) / BPS_SCALE
  return bumped > fee ? bumped : fee + 1n
}

function validHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || ""))
}

function broadcastUncertain(error) {
  return Boolean(error?.broadcastUncertain || error?.code === "BROADCAST_UNCERTAIN" || /(?:timed? ?out|timeout|deadline exceeded|ETIMEDOUT|aborted)/i.test(String(error?.message || "")))
}

function pendingBroadcastMessage() {
  return "广播请求超时，结果待确认；系统不会自动重发"
}

function jobSummary(job) {
  const statuses = [...job.results, ...job.replacements].map((result) => result.status)
  return {
    wallets: job.wallets.length,
    eligibleWallets: job.wallets.filter((wallet) => wallet.preflightStatus === "ready").length,
    failedWallets: job.wallets.filter((wallet) => wallet.preflightStatus === "failed").length,
    rounds: job.input.rounds,
    plannedTransactions: job.wallets.filter((wallet) => wallet.preflightStatus === "ready").length * job.input.rounds,
    attempted: job.results.length,
    pending: statuses.filter((status) => status === "confirmation_pending").length,
    confirmed: statuses.filter((status) => status === "confirmed").length,
    failed: statuses.filter((status) => status === "failed").length,
    replaced: statuses.filter((status) => status === "replaced").length,
    cancelled: job.replacements.filter((result) => result.kind === "cancel").length,
  }
}

function publicJob(job, { includeConfirmation = false } = {}) {
  return {
    id: job.id,
    taskId: job.taskId,
    status: job.status,
    chain: job.chain,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scheduleAt: job.input.scheduleAt,
    rpcProfileId: job.input.rpcProfileId,
    rpcProfileRef: job.input.rpcProfileRef || "",
    stopRequested: job.stopRequested,
    input: job.input,
    wallets: job.wallets,
    results: job.results,
    replacements: job.replacements,
    logs: job.logs,
    summary: jobSummary(job),
    confirmation: includeConfirmation && job.status === "previewed" ? job.confirmation : undefined,
  }
}

async function resolveFees(client, input) {
  if (!input.autoFee) {
    return input.eip1559
      ? { maxFeePerGas: input.maxFeePerGasWei, maxPriorityFeePerGas: input.maxPriorityFeePerGasWei }
      : { gasPrice: input.gasPriceWei }
  }
  if (!input.eip1559) return { gasPrice: (await client.getGasPrice()).toString() }
  const fees = await client.estimateFeesPerGas({ type: "eip1559" })
  return {
    maxFeePerGas: fees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
  }
}

export function createAdvancedMintService({
  getChain,
  getClient,
  getWallets,
  sendTransaction,
  resolveRpcProfile = (profileId) => ({ id: String(profileId || "main") }),
  startTask = () => "",
  finishTask = () => {},
  logTransaction = () => null,
  updateTransaction = () => {},
  confirmationTtlMs = 10 * 60 * 1000,
  jobTtlMs = 30 * 60 * 1000,
  nowMs = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule = (run, ms) => setTimeout(run, ms),
  unschedule = (timer) => clearTimeout(timer),
  createId = randomUUID,
} = {}) {
  const jobs = new Map()
  const confirmations = createTaskConfirmationStore({ ttlMs: confirmationTtlMs, now: nowMs })

  function timestamp() {
    return new Date(nowMs()).toISOString()
  }

  function touch(job) {
    job.updatedAt = timestamp()
    job.expiresAtMs = nowMs() + jobTtlMs
  }

  function append(job, level, message, details = undefined) {
    job.logs.push({ at: timestamp(), level, message, ...(details ? { details } : {}) })
    if (job.logs.length > LOG_LIMIT) job.logs.splice(0, job.logs.length - LOG_LIMIT)
    touch(job)
  }

  function requireJob(id) {
    const job = jobs.get(String(id || ""))
    if (!job) throw serviceError(404, "高级铸造任务不存在或已过期")
    return job
  }

  function cleanup() {
    const current = nowMs()
    for (const [id, job] of jobs) {
      if (["scheduled", "running", "stopping"].includes(job.status)) continue
      if (job.expiresAtMs <= current) jobs.delete(id)
    }
    confirmations.cleanup()
  }

  async function preview(body) {
    cleanup()
    const input = normalizeAdvancedMintInput(body || {})
    if (input.waitMode === "zero-block" && input.autoGas) {
      throw serviceError(400, "零区块模式需要手动设置 Gas 上限")
    }
    const chain = getChain(input.chainId)
    const selectedProfile = resolveRpcProfile(input.rpcProfileId, chain.id, input.rpcProfileRef || "")
    input.rpcProfileId = selectedProfile.id
    input.rpcProfileRef = selectedProfile.profileRef || input.rpcProfileRef || ""
    const allWallets = getWallets()
    const selected = input.walletIds.map((id) => {
      const wallet = allWallets.find((candidate) => candidate.id === id)
      if (!wallet) throw serviceError(404, `未找到钱包：${id}`)
      return wallet
    })
    const transactions = buildAdvancedMintTransactions(input, selected)
    const client = getClient(chain.id)
    const fees = await resolveFees(client, input)
    const wallets = []

    for (const transaction of transactions) {
      const wallet = selected.find((candidate) => candidate.id === transaction.walletId)
      try {
        if (wallet.source && wallet.source !== "root-env") {
          throw new Error("高级费用与替换控制需要使用本地密钥钱包")
        }
        if (input.preflight) {
          await client.call({
            account: wallet.address,
            to: transaction.to,
            value: BigInt(transaction.valueWei),
            data: transaction.data,
          })
        }
        let gas = transaction.gas || ""
        let gasWarning = ""
        if (!gas) {
          try {
            const estimate = await client.estimateGas({
              account: wallet.address,
              to: transaction.to,
              value: BigInt(transaction.valueWei),
              data: transaction.data,
            })
            gas = bufferedGas(estimate).toString()
          } catch (error) {
            if (!input.allowGasFailure) throw error
            gasWarning = `Gas 估算失败，签名器发送时将重试：${errorMessage(error)}`
          }
        }
        const nonce = input.prefetchNonce
          ? await client.getTransactionCount({ address: wallet.address, blockTag: "pending" })
          : null
        const balanceWei = await client.getBalance({ address: wallet.address })
        const feePerGas = fees.gasPrice || fees.maxFeePerGas || "0"
        const estimatedFeeWei = gas ? BigInt(gas) * BigInt(feePerGas) : 0n
        const requiredWei = BigInt(transaction.valueWei) + estimatedFeeWei
        if (balanceWei < requiredWei) {
          throw new Error(`余额不足：可用 ${balanceWei} wei，交易金额与最高费用共需 ${requiredWei} wei`)
        }
        wallets.push({
          ...transaction,
          ...fees,
          address: wallet.address,
          gas,
          nonce,
          balanceWei: balanceWei.toString(),
          estimatedFeeWei: estimatedFeeWei.toString(),
          estimatedTotalWei: requiredWei.toString(),
          preflightStatus: "ready",
          warning: gasWarning,
        })
      } catch (error) {
        wallets.push({
          ...transaction,
          ...fees,
          address: wallet.address,
          gas: transaction.gas || "",
          nonce: null,
          preflightStatus: "failed",
          error: errorMessage(error),
        })
      }
    }

    const createdAt = timestamp()
    const job = {
      id: createId(),
      taskId: "",
      status: "previewed",
      chain: { id: chain.id, name: chain.name, nativeSymbol: chain.nativeSymbol },
      createdAt,
      updatedAt: createdAt,
      expiresAtMs: nowMs() + jobTtlMs,
      input,
      wallets,
      results: [],
      replacements: [],
      logs: [],
      confirmation: null,
      stopRequested: false,
      timer: null,
      runPromise: null,
    }
    job.confirmation = confirmations.create("advanced_mint", { jobId: job.id })
    append(job, "info", `预览已固定 ${wallets.filter((wallet) => wallet.preflightStatus === "ready").length} 个可执行钱包和 ${input.rounds} 个轮次`)
    jobs.set(job.id, job)
    return publicJob(job, { includeConfirmation: true })
  }

  async function sendOne(job, wallet, round) {
    const nonce = wallet.nonce === null || wallet.nonce === undefined ? null : Number(wallet.nonce) + round - 1
    const entry = {
      walletId: wallet.walletId,
      address: wallet.address,
      chainId: job.chain.id,
      rpcProfileId: job.input.rpcProfileId,
      rpcProfileRef: job.input.rpcProfileRef || "",
      to: wallet.to,
      valueWei: wallet.valueWei,
      data: wallet.data,
      gas: wallet.gas,
      gasPrice: wallet.gasPrice,
      maxFeePerGas: wallet.maxFeePerGas,
      maxPriorityFeePerGas: wallet.maxPriorityFeePerGas,
      nonce,
      round,
    }
    const rowId = logTransaction({
      taskId: job.taskId,
      walletId: entry.walletId,
      chainId: job.chain.id,
      type: "advanced_mint",
      status: "running",
      summary: `${entry.walletId} 第 ${round} 轮 ${wallet.method}`,
      metadata: entry,
    })
    const result = { ...entry, txLogId: rowId === null ? null : String(rowId), status: "running", txHash: "", error: "" }
    job.results.push(result)
    append(job, "info", `第 ${round} 轮：正在发送 ${entry.walletId}`, { nonce })
    try {
      if (job.input.preflight) {
        await getClient(job.chain.id).call({
          account: entry.address,
          to: entry.to,
          value: BigInt(entry.valueWei),
          data: entry.data,
        })
      }
      const sent = await sendTransaction(entry)
      const txHash = String(sent.txHash || "")
      if (!validHash(txHash)) throw new Error("钱包签名器未返回有效交易哈希")
      result.txHash = txHash
      result.status = "confirmation_pending"
      updateTransaction(rowId, { status: "confirmation_pending", tx_hash: txHash, metadata_json: { ...entry, sent } })
      append(job, "success", `第 ${round} 轮：${entry.walletId} 的广播已被接受`, { txHash, nonce })
      if (job.input.waitMode === "confirmed") {
        try {
          const receipt = await getClient(job.chain.id).waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
          result.status = receipt.status === "success" ? "confirmed" : "failed"
          result.blockNumber = receipt.blockNumber?.toString() || ""
          result.error = receipt.status === "success" ? "" : "交易已在链上回退"
          updateTransaction(rowId, { status: result.status, error: result.error })
          append(job, result.status === "confirmed" ? "success" : "error", `第 ${round} 轮：${entry.walletId} ${result.status === "confirmed" ? "已确认" : "失败"}`, { txHash })
        } catch (error) {
          result.error = `交易仍待确认：${errorMessage(error)}`
          updateTransaction(rowId, { status: "confirmation_pending", error: result.error })
          append(job, "warning", `第 ${round} 轮：${entry.walletId} 的交易仍待确认`, { txHash })
        }
      }
    } catch (error) {
      if (broadcastUncertain(error)) {
        result.status = "confirmation_pending"
        result.uncertain = true
        result.error = pendingBroadcastMessage()
        updateTransaction(rowId, { status: "confirmation_pending", error: result.error, metadata_json: { ...entry, broadcastStage: "unknown" } })
        append(job, "warning", `第 ${round} 轮：${entry.walletId} 的广播结果待确认`, { error: result.error, nonce })
      } else {
        result.status = "failed"
        result.error = errorMessage(error)
        updateTransaction(rowId, { status: "failed", error: result.error })
        append(job, "error", `第 ${round} 轮：${entry.walletId} 执行失败`, { error: result.error })
      }
    }
    touch(job)
    return result
  }

  async function execute(job) {
    if (job.stopRequested) return
    job.status = "running"
  job.taskId = startTask("advanced_mint", {
      chainId: job.chain.id,
      rpcProfileId: job.input.rpcProfileId,
      input: job.input,
      wallets: job.wallets.map((wallet) => ({ walletId: wallet.walletId, address: wallet.address, preflightStatus: wallet.preflightStatus })),
    })
    append(job, "info", "高级铸造任务已开始", { taskId: job.taskId })
    const eligible = job.wallets.filter((wallet) => wallet.preflightStatus === "ready")
    if (!eligible.length) {
      job.status = "failed"
      finishTask(job.taskId, "failed", { results: [] }, "没有钱包通过预检")
      append(job, "error", "没有钱包通过预检")
      return
    }

    try {
      for (let round = 1; round <= job.input.rounds && !job.stopRequested; round += 1) {
        append(job, "info", `第 ${round}/${job.input.rounds} 轮已开始`)
        if (job.input.executionMode === "burst") {
          await Promise.all(eligible.map((wallet) => sendOne(job, wallet, round)))
          if (round < job.input.rounds && !job.stopRequested) await delay(job.input.frequencyMs)
        } else {
          for (let index = 0; index < eligible.length && !job.stopRequested; index += 1) {
            await sendOne(job, eligible[index], round)
            const hasNext = round < job.input.rounds || index < eligible.length - 1
            if (hasNext && !job.stopRequested) await delay(job.input.frequencyMs)
          }
        }
      }
      const summary = jobSummary(job)
      if (job.stopRequested) job.status = "stopped"
      else if (summary.pending) job.status = summary.failed ? "partial" : "confirmation_pending"
      else if (summary.failed) job.status = summary.confirmed ? "partial" : "failed"
      else job.status = "completed"
      finishTask(job.taskId, job.status === "completed" ? "done" : job.status, { results: job.results }, job.status === "failed" ? "所有高级铸造交易均失败" : "")
      append(job, "info", `高级铸造任务${job.status === "completed" ? "已完成" : job.status === "stopped" ? "已停止" : job.status === "failed" ? "失败" : "部分完成"}`)
    } catch (error) {
      job.status = "failed"
      finishTask(job.taskId, "failed", { results: job.results }, errorMessage(error))
      append(job, "error", "高级铸造任务失败", { error: errorMessage(error) })
    }
  }

  function send({ jobId, previewId, confirmationToken }) {
    const job = requireJob(jobId)
    if (job.status !== "previewed") throw serviceError(409, "高级铸造任务当前状态不允许发送")
    const confirmed = confirmations.consume("advanced_mint", previewId, confirmationToken)
    if (confirmed.jobId !== job.id) throw serviceError(409, "预览凭据不属于当前高级铸造任务")
    job.confirmation = null
    const scheduledMs = job.input.scheduleAt ? Date.parse(job.input.scheduleAt) - nowMs() : 0
    if (scheduledMs > 0) {
      job.status = "scheduled"
      job.timer = schedule(() => {
        job.timer = null
        job.runPromise = execute(job)
      }, scheduledMs)
      append(job, "info", `任务已定时至 ${job.input.scheduleAt}`)
    } else {
      job.status = "running"
      job.runPromise = execute(job)
    }
    touch(job)
    return publicJob(job)
  }

  function stop(id) {
    const job = requireJob(id)
    if (job.status === "scheduled" && job.timer) {
      unschedule(job.timer)
      job.timer = null
      job.stopRequested = true
      job.status = "stopped"
      append(job, "warning", "定时任务已在首次广播前停止")
      return publicJob(job)
    }
    if (!["running", "stopping"].includes(job.status)) throw serviceError(409, "高级铸造任务当前状态不允许停止")
    job.stopRequested = true
    job.status = "stopping"
    append(job, "warning", "已请求停止，当前 RPC 操作完成后生效")
    return publicJob(job)
  }

  function pendingResult(job, walletId) {
    const result = [...job.results].reverse().find((candidate) => (
      candidate.status === "confirmation_pending" && (!walletId || candidate.walletId === walletId)
    ))
    if (!result) throw serviceError(409, "没有与请求匹配的待确认高级铸造交易")
    if (result.nonce === null || result.nonce === undefined) throw serviceError(409, "待确认交易没有固定交易序号")
    return result
  }

  async function replace(id, body, kind) {
    const job = requireJob(id)
    const original = pendingResult(job, String(body.walletId || ""))
    const multiplier = Number(body.multiplier ?? 1.2)
    if (!Number.isFinite(multiplier) || multiplier < 1.2 || multiplier > 10) {
      throw serviceError(400, "替换费用倍数必须介于 1.2 和 10 之间")
    }
    const fees = original.gasPrice
      ? { gasPrice: bumpedFee(original.gasPrice, multiplier).toString() }
      : {
          maxFeePerGas: bumpedFee(original.maxFeePerGas, multiplier).toString(),
          maxPriorityFeePerGas: bumpedFee(original.maxPriorityFeePerGas, multiplier).toString(),
        }
    const entry = kind === "cancel"
      ? { walletId: original.walletId, address: original.address, chainId: job.chain.id, rpcProfileId: job.input.rpcProfileId, rpcProfileRef: job.input.rpcProfileRef || "", to: original.address, valueWei: "0", data: "0x", gas: "21000", nonce: original.nonce, ...fees }
      : { walletId: original.walletId, address: original.address, chainId: job.chain.id, rpcProfileId: job.input.rpcProfileId, rpcProfileRef: job.input.rpcProfileRef || "", to: original.to, valueWei: original.valueWei, data: original.data, gas: original.gas, nonce: original.nonce, ...fees }
    const rowId = logTransaction({
      taskId: job.taskId || job.id,
      walletId: entry.walletId,
      chainId: job.chain.id,
      type: kind === "cancel" ? "advanced_mint_cancel" : "advanced_mint_accelerate",
      status: "running",
      summary: `${kind === "cancel" ? "取消" : "加速"} ${entry.walletId} 交易序号 ${entry.nonce}`,
      metadata: { ...entry, replaces: original.txHash },
    })
    try {
      const sent = await sendTransaction(entry)
      const txHash = String(sent.txHash || "")
      if (!validHash(txHash)) throw new Error("钱包签名器未返回有效的替换交易哈希")
      const replacement = {
        kind,
        walletId: entry.walletId,
        address: entry.address,
        nonce: entry.nonce,
        txHash,
        replaces: original.txHash,
        status: "confirmation_pending",
        txLogId: rowId === null ? null : String(rowId),
        ...fees,
      }
      original.status = "replaced"
      original.replacedBy = txHash
      job.replacements.push(replacement)
      job.status = "confirmation_pending"
      updateTransaction(original.txLogId, { status: "replaced", metadata_json: { ...original, replacedBy: txHash } })
      updateTransaction(rowId, { status: "confirmation_pending", tx_hash: txHash, metadata_json: { ...entry, sent, replaces: original.txHash } })
      append(job, "success", `${kind === "cancel" ? "取消" : "加速"}交易广播已被接受`, { txHash, replaces: original.txHash, nonce: entry.nonce })
      return publicJob(job)
    } catch (error) {
      if (broadcastUncertain(error)) {
        const replacement = {
          kind,
          walletId: entry.walletId,
          address: entry.address,
          nonce: entry.nonce,
          txHash: "",
          replaces: original.txHash,
          status: "confirmation_pending",
          uncertain: true,
          txLogId: rowId === null ? null : String(rowId),
          ...fees,
        }
        job.replacements.push(replacement)
        job.status = "confirmation_pending"
        updateTransaction(rowId, { status: "confirmation_pending", error: pendingBroadcastMessage(), metadata_json: { ...entry, replaces: original.txHash, broadcastStage: "unknown" } })
        append(job, "warning", `${kind === "cancel" ? "取消" : "加速"}交易广播结果待确认`, { replaces: original.txHash, nonce: entry.nonce })
        touch(job)
        return publicJob(job)
      }
      updateTransaction(rowId, { status: "failed", error: errorMessage(error) })
      append(job, "error", `${kind === "cancel" ? "取消" : "加速"}交易失败`, { error: errorMessage(error) })
      throw error
    }
  }

  async function reconcile(id) {
    const job = requireJob(id)
    const pending = [
      ...job.results.filter((result) => result.status === "confirmation_pending"),
      ...job.replacements.filter((result) => result.status === "confirmation_pending"),
    ]
    for (const result of pending) {
      try {
        const receipt = await getClient(job.chain.id).getTransactionReceipt({ hash: result.txHash })
        result.status = receipt.status === "success" ? "confirmed" : "failed"
        result.blockNumber = receipt.blockNumber?.toString() || ""
        result.error = receipt.status === "success" ? "" : "交易已在链上回退"
        if (result.txLogId) updateTransaction(result.txLogId, { status: result.status, error: result.error })
      } catch {
        // Receipt absence is the expected pending state.
      }
    }
    const summary = jobSummary(job)
    if (!["running", "scheduled", "stopping", "stopped"].includes(job.status)) {
      if (summary.pending) job.status = summary.failed ? "partial" : "confirmation_pending"
      else if (summary.failed) job.status = summary.confirmed ? "partial" : "failed"
      else if (summary.attempted) job.status = "completed"
    }
    touch(job)
    return publicJob(job)
  }

  return {
    accelerate: (id, body = {}) => replace(id, body, "accelerate"),
    cancel: (id, body = {}) => replace(id, body, "cancel"),
    cleanup,
    get: (id) => publicJob(requireJob(id), { includeConfirmation: true }),
    preview,
    reconcile,
    send,
    stop,
  }
}
