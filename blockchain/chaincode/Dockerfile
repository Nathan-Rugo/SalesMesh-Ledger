# Pins its own builder: the testnet's GOLANG_IMAGE (Go 1.24, used by the smoke chaincode) is out of
# support and too old for the patched gRPC this module needs (govulncheck-clean as of 2026-10-20).
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
