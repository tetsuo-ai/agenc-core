declare module 'react-reconciler' {
  export type FiberRoot = any;
  const createReconciler: any;
  export default createReconciler;
}

declare module 'react-reconciler/constants.js' {
  export const LegacyRoot: any;
}
