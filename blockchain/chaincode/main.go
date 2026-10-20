// Commission escrow chaincode (DLT-02, #9). Runs as a CCaaS server; the peers dial it.
package main

import (
	"fmt"
	"os"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
)

func main() {
	srv := &shim.ChaincodeServer{
		CCID:     os.Getenv("CHAINCODE_ID"),
		Address:  os.Getenv("CHAINCODE_SERVER_ADDRESS"),
		CC:       commission{},
		TLSProps: shim.TLSProperties{Disabled: true}, // plaintext inside the Docker network (documented limit)
	}
	if srv.CCID == "" || srv.Address == "" {
		fmt.Fprintln(os.Stderr, "CHAINCODE_ID and CHAINCODE_SERVER_ADDRESS are required")
		os.Exit(1)
	}
	if err := srv.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "chaincode server:", err)
		os.Exit(1)
	}
}
