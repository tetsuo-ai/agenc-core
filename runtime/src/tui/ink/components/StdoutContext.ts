import { createContext } from "react";

const StdoutContext = createContext<NodeJS.WriteStream>(process.stdout);

StdoutContext.displayName = "InkStdoutContext";

export default StdoutContext;
