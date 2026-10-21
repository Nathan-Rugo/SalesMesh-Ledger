# Pins its own builder, the same as the testnet's GOLANG_IMAGE (golang:1.27-alpine) used by the smoke
# chaincode: a supported Go with the patched gRPC (govulncheck runs on both modules in CI).
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chaincode .

FROM scratch
COPY --from=build /out/chaincode /chaincode
USER 65534:65534
ENTRYPOINT ["/chaincode"]
