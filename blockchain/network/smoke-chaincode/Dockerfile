ARG GOLANG_IMAGE
FROM ${GOLANG_IMAGE} AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chaincode .

FROM scratch
COPY --from=build /out/chaincode /chaincode
USER 65534:65534
ENTRYPOINT ["/chaincode"]
