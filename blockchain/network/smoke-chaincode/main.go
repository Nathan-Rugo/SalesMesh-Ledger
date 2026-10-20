// Smoke chaincode for the testnet: put/get only. Runs as a CCaaS server; the peer dials it.
package main

import (
	"fmt"
	"os"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

type smoke struct{}

func (smoke) Init(shim.ChaincodeStubInterface) *peer.Response { return shim.Success(nil) }

func (smoke) Invoke(stub shim.ChaincodeStubInterface) *peer.Response {
	fn, args := stub.GetFunctionAndParameters()
	switch {
	case fn == "put" && len(args) == 2:
		if err := stub.PutState(args[0], []byte(args[1])); err != nil {
			return shim.Error(err.Error())
		}
		return shim.Success(nil)
	case fn == "get" && len(args) == 1:
		v, err := stub.GetState(args[0])
		if err != nil {
			return shim.Error(err.Error())
		}
		if v == nil {
			return shim.Error("key not found: " + args[0])
		}
		return shim.Success(v)
	}
	return shim.Error("usage: put <key> <value> | get <key>")
}

func main() {
	srv := &shim.ChaincodeServer{
		CCID:     os.Getenv("CHAINCODE_ID"),
		Address:  os.Getenv("CHAINCODE_SERVER_ADDRESS"),
		CC:       smoke{},
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
