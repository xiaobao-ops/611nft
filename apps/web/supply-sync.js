function supplyNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function resolveMintSupplyUpdate(detail, event) {
  const detailCurrentSupply = supplyNumber(detail?.current_supply);
  const detailMaxSupply = supplyNumber(detail?.max_supply);
  const eventCurrentSupply = supplyNumber(event?.current_supply);
  const eventMaxSupply = supplyNumber(event?.max_supply);
  const eventIsCurrent = eventCurrentSupply != null
    && (detailCurrentSupply == null || eventCurrentSupply >= detailCurrentSupply);
  return {
    currentSupply: eventCurrentSupply == null
      ? detailCurrentSupply
      : Math.max(detailCurrentSupply ?? 0, eventCurrentSupply),
    maxSupply: eventIsCurrent ? (eventMaxSupply ?? detailMaxSupply) : detailMaxSupply,
    authoritative: eventCurrentSupply != null,
  };
}
