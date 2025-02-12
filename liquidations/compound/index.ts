import { gql } from "graphql-request";
import { getPagedGql } from "../utils/gql";
import BigNumber from "bignumber.js";
import { Liq } from "../utils/binResults";
import {
  Account,
  borrowBalanceUnderlying,
  getMarkets,
  getUnderlyingPrices,
  supplyBalanceUnderlying,
  totalBorrowValueInUsd,
  totalCollateralValueInUsd,
} from "../utils/compound-helpers";

const subgraphUrl = "https://api.thegraph.com/subgraphs/name/graphprotocol/compound-v2";

const accountsQuery = gql`
  query accounts($lastId: ID) {
    accounts(first: 1000, where: { hasBorrowed: true, id_gt: $lastId }) {
      id
      tokens {
        id
        cTokenBalance
        accountBorrowIndex
        storedBorrowBalance
        market {
          id
          name
          symbol

          exchangeRate
          collateralFactor
          borrowIndex

          underlyingAddress
        }
        enteredMarket
      }
      hasBorrowed
    }
    _meta {
      block {
        number
      }
    }
  }
`;

const EXPLORER_BASE_URL = "https://etherscan.io/address/";

const positions = async () => {
  const accounts = (await getPagedGql(subgraphUrl, accountsQuery, "accounts")) as Account[];
  const markets = await getMarkets(subgraphUrl);
  const prices = await getUnderlyingPrices(markets, "ethereum:");

  // all positions across all users
  const positions = accounts.flatMap((account) => {
    const _totalBorrowValueInUsd = totalBorrowValueInUsd(account, prices, "ethereum:");
    const _totalCollateralValueInUsd = totalCollateralValueInUsd(account, prices, "ethereum:");

    const debts = account.tokens
      .filter((token) => {
        const _borrowBalanceUnderlying = borrowBalanceUnderlying(token);
        const _supplyBalanceUnderlying = supplyBalanceUnderlying(token);
        return !(_borrowBalanceUnderlying.eq(0) && _supplyBalanceUnderlying.eq(0));
      })
      .map((token) => {
        const _borrowBalanceUnderlying = borrowBalanceUnderlying(token);
        const _supplyBalanceUnderlying = supplyBalanceUnderlying(token);
        const _price = prices["ethereum:" + token.market.underlyingAddress];
        if (!_price) {
          console.log("no price for", "ethereum:" + token.market.underlyingAddress);
          return {
            debt: new BigNumber(0),
            price: 0,
            token: "ethereum:" + token.market.underlyingAddress,
            totalBal: _supplyBalanceUnderlying,
            decimals: 0,
          };
        }
        const decimals = _price.decimals;
        const price = _price.price;
        const collateralFactor = Number(token.market.collateralFactor); // equivalent to liqThreshold in aave
        let debt = _borrowBalanceUnderlying;
        if (token.enteredMarket) {
          const factoredSupply = _supplyBalanceUnderlying.times(collateralFactor);
          debt = debt.minus(factoredSupply);
        }
        debt = debt.times(price);
        return {
          debt,
          price,
          token: "ethereum:" + token.market.underlyingAddress,
          totalBal: _supplyBalanceUnderlying,
          decimals,
        };
      });

    const liquidablePositions = debts
      .filter(({ debt }) => debt.lt(0))
      .map((pos) => {
        const usdPosNetCollateral = pos.debt.negated();
        const otherCollateral = _totalCollateralValueInUsd.minus(usdPosNetCollateral);
        const diffDebt = _totalBorrowValueInUsd.minus(otherCollateral);
        if (diffDebt.gt(0)) {
          const amountCollateral = usdPosNetCollateral.div(pos.price);
          const liqPrice = diffDebt.div(amountCollateral);
          return {
            owner: account.id,
            liqPrice: Number(liqPrice.toFixed(6)),
            collateral: pos.token,
            collateralAmount: pos.totalBal.times(10 ** pos.decimals).toFixed(0),
            extra: {
              url: EXPLORER_BASE_URL + account.id,
            },
          } as Liq;
        } else {
          return {
            owner: "",
            liqPrice: 0,
            collateral: "",
            collateralAmount: "",
          };
        }
      })
      .filter((t) => !!t.owner);

    return liquidablePositions;
  });

  return positions;
};

module.exports = {
  ethereum: {
    liquidations: positions,
  },
};
