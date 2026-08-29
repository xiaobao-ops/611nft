const offerItem = [
  { name: "itemType", type: "uint8" },
  { name: "token", type: "address" },
  { name: "identifierOrCriteria", type: "uint256" },
  { name: "startAmount", type: "uint256" },
  { name: "endAmount", type: "uint256" },
]

const considerationItem = [...offerItem, { name: "recipient", type: "address" }]

const orderParameters = [
  { name: "offerer", type: "address" },
  { name: "zone", type: "address" },
  { name: "offer", type: "tuple[]", components: offerItem },
  { name: "consideration", type: "tuple[]", components: considerationItem },
  { name: "orderType", type: "uint8" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "zoneHash", type: "bytes32" },
  { name: "salt", type: "uint256" },
  { name: "conduitKey", type: "bytes32" },
  { name: "totalOriginalConsiderationItems", type: "uint256" },
]

const advancedOrder = [
  { name: "parameters", type: "tuple", components: orderParameters },
  { name: "numerator", type: "uint120" },
  { name: "denominator", type: "uint120" },
  { name: "signature", type: "bytes" },
  { name: "extraData", type: "bytes" },
]

const criteriaResolver = [
  { name: "orderIndex", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "index", type: "uint256" },
  { name: "identifier", type: "uint256" },
  { name: "criteriaProof", type: "bytes32[]" },
]

const fulfillmentComponent = [
  { name: "orderIndex", type: "uint256" },
  { name: "itemIndex", type: "uint256" },
]

const fulfillment = [
  { name: "offerComponents", type: "tuple[]", components: fulfillmentComponent },
  { name: "considerationComponents", type: "tuple[]", components: fulfillmentComponent },
]

export const SeaportFulfillmentAbi = [
  {
    type: "function",
    name: "fulfillAdvancedOrder",
    stateMutability: "payable",
    inputs: [
      { name: "advancedOrder", type: "tuple", components: advancedOrder },
      { name: "criteriaResolvers", type: "tuple[]", components: criteriaResolver },
      { name: "fulfillerConduitKey", type: "bytes32" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "fulfilled", type: "bool" }],
  },
  {
    type: "function",
    name: "matchAdvancedOrders",
    stateMutability: "payable",
    inputs: [
      { name: "orders", type: "tuple[]", components: advancedOrder },
      { name: "criteriaResolvers", type: "tuple[]", components: criteriaResolver },
      { name: "fulfillments", type: "tuple[]", components: fulfillment },
      { name: "recipient", type: "address" },
    ],
    outputs: [
      {
        name: "executions",
        type: "tuple[]",
        components: [
          {
            name: "item",
            type: "tuple",
            components: [
              { name: "itemType", type: "uint8" },
              { name: "token", type: "address" },
              { name: "identifier", type: "uint256" },
              { name: "amount", type: "uint256" },
              { name: "recipient", type: "address" },
            ],
          },
          { name: "offerer", type: "address" },
          { name: "conduitKey", type: "bytes32" },
        ],
      },
    ],
  },
]
