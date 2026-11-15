---
title: Spring Boot
sidebar_position: 5
---

# Spring Boot

[Spring Boot Docs](https://docs.spring.io/spring-boot/index.html)

## Project Architecture

Spring Boot has a steeper learning curve compared to simpler frameworks like FastAPI due to its structured layout and vast ecosystem. Spring Boot allows you to build exteremely robust applications.

Spring Boot projects typically follow a layered architecture:

```
src/main/java/com/example/project/
├── controller/        → REST API endpoints
├── service/           → Business logic, validation, transformations
├── repository/        → Database queries (JPA/Hibernate)
├── model/             → Entity classes (map to database tables)
├── dto/               → Data Transfer Objects (define request and response objects)
├── security/          → Security features (authentication, middleware)
├── exceptions/        → Custom exceptions (API error responses)
├── config/            → Project or third-party library configurations
├── util/              → Miscellaneous classes and methods
└── Application.java   → Main entry point
```

## Controllers

Controllers define your API endpoints and should be pretty simple. Logic such as data transformation and database queries should be handled in the service layer. The controller should make a call to the service and return it with minimal logic.

Each controller class defines a collection of endpoints. You define a controller class with the `@RestController` annotation at the top of the class. You can specify the base URL of the class with `@RequestMaping("/api/example")`.

You define a method as an endpoint and how it will be handled with one of:

- `@GetMapping` (GET request)
- `@PostMapping` (POST request)
- `@PutMapping` (PUT request)
- `@DeleteMapping` (DELETE request)

You can specify a deeper URL than the base URL for each endpoint, and define path parameters.

In each method, you can define parameters for the request body, path parameters, query parameters, security/authentication, and more.

Full example:

```java
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
private final UserService userService;

    // Spring Boot automatically injects an instance of UserService
    public UserController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/{id}") // defines path parameter "id"
    public UserDto getUser(@PathVariable Long id) {
        return userService.getUserById(id);
    }

    @PostMapping("/create") // full path is /api/users/create
    public UserDto createUser(@RequestBody CreateUserDto dto) {
        return userService.createUser(dto);
    }
}
```

### Dependency Injection

Spring Boot uses dependency injection (DI): it scans for classes annotated with `@RestController`, `@Service`, `@Repository`, `@Component`, etc., creates instances (called beans), and injects them wherever needed.

In the example above, the `UserController` class doesn't manually create a `UserService` instance. It simply defines the field and Spring Boot automatically injects it in.

So basically, you can define things such as services or repositories just as a variable, and use them like normal as if they were instantiated in the constructor.

## Services

The service layer handles the meat of the work. Any business logic, data transformations, database queries (through repositories), or other error handling will be handled here. Methods you define here should be called in controllers and other services.

Add the `@Service` annotation to the top of your classes.

Full example:

```java
import org.springframework.stereotype.Service;

@Data
@Service
public class UserService {
    private final UserRepository userRepository;

    // Spring injects UserRepository automatically
    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public UserDto getUserById(Long id) {
        return userRepository.findById(id)
                .map(UserMapper::toDto)
                .orElseThrow(() -> new RuntimeException("User not found"));
    }

    public UserDto createUser(CreateUserDto dto) {
        User user = new User(dto.getName(), dto.getEmail());
        return UserMapper.toDto(userRepository.save(user));
    }
}
```

## Repositories

Repositories let you interact with your database without writing boilerplate query code. This places a layer of abstraction over complex queries and makes calls readable in your services.

You must define an interface that extends one of Spring's built-in interfaces which provides some basic functionality. `JpaRepository<T, ID>` is the most common, which provides basic CRUD functionality.

You can define custom queries by method name (e.g. `findByName`, `findByEmail`) or manually using `@Query` if you prefer SQL. [Spring requires a specific format](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html) for custom method names. If you cannot define your query this way, writing SQL with `@Query` is recommended.

Add the `@Repository` annotation to the top of your classes.

Full example:

```java
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;
import com.exiger.supplierportal.model.UserAccount;
import java.util.List;
import java.util.Optional;

@Repository
public interface UserAccountRepository extends JpaRepository<UserAccount, String> {
    // JpaRepository provides methods like save(), findById(), findAll(), deleteById(), etc

    // custom query using method name
    Optional<UserAccount> findByUserEmail(String userEmail);

    // custom query created manually with SQL string
    @Query("SELECT u.userEmail FROM UserAccount u")
    List<String> findAllUserEmails();
}
```

## Models/Entities

Entities map Java objects to database tables using JPA annotations. There are a lot of different ones, but generally for basic data types having the @Entity annotation will be sufficient.

Common Annotations:

- `@Entity` - Marks a class as a JPA entity (table)
- `@Table` - Defines the table name
- `@Id` - Primary key field
- `@GeneratedValue` - Define strategy for generating primary key when inserting
- `@Column` - Map a property (e.g. value constraints) to a specific column. Not required.
- `@ManyToOne` and `@JoinColumn` - Used in conjunction to define a foreign key column

Full example:

```java
import jakarta.persistence.*;

@Data
@Entity
@Table(name = "users")
public class User {
    // primary key
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;

    @Column(unique = true)
    private String email;

    // foreign key column referencing "client_supplier_id" field of entity "ClientSupplier"
    @ManyToOne(optional = false)
    @JoinColumn(name = "client_supplier_id", nullable = false)
    private ClientSupplier clientSupplier;
}
```

## DTOs

Data Transfer Objects (DTOs) are Java objects used to separate internal entity models from API request/response payloads.

These define your API payloads, which keeps API contracts stable even if the internal model changes.
Spring Boot automatically parses JSON inputs into a DTO. If it fails to parse (e.g. types don't match up or missing fields), it will do error handling automatically (before you even get to your controller code).

It's best practice to create `/request` and `/response` folders within your `/dto` folder.

Full example:

```java
public class UserAccountRequest {
    @NotBlank // marks field as required
    @Email(message = "Email is invalid") // Spring Boot checks that the input is an email
    private String userEmail;

    @NotBlank
    private String firstName;

    @NotBlank
    private String lastName;
}
```

## Lombok

Lombok reduces boilerplate code like getters, setters, constructors.

PLEASE use this AS MUCH AS YOU CAN it is the most helpful library and will make your code so much easier to write and maintain.

Common annotations:

- `@Data` – Generates getters, setters, toString, equals, hashCode
- `@Getter`, `@Setter` – Generate individually
- `@NoArgsConstructor`, `@AllArgsConstructor` – Generate constructors
- `@Builder` – Fluent builder pattern

Specifically use `@Data` and `@AllArgsConstructor` as well as `@NoArgsConstructor` to auto generate constructors and other utility functions.

Full example:

```java
import lombok.Data;
import jakarta.persistence.*;

@Entity
@Data // generates getters, setters, equals, hashCode, toString
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String title;
    private double price;
}
```

## Database Integration with PostgreSQL

Spring Boot integrates with PostgreSQL through Spring Data JPA and Hibernate.

Add configurations inside `application.properties` or `application.yaml`:

```
spring.datasource.url=jdbc:postgresql://localhost:5432/mydb
spring.datasource.username=postgres
spring.datasource.password=secret
spring.jpa.hibernate.ddl-auto=update
spring.jpa.show-sql=true
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
```

How it works:

1. Hibernate inspects your `@Entity` classes
2. Creates tables/columns automatically if `ddl-auto=update`
3. Queries run through repository interface methods (`findAll`, `save`, etc.).

## Summary

Controller → Defines REST endpoints (`@RestController`, `@GetMapping`, etc.). Uses dependency injection to get services.

Service → Business logic, injected with repositories and other services.

Repository → Database queries using Spring Data JPA.

Entity → Maps to database tables via Hibernate.

DTOs → Shape request/response objects for APIs.

Lombok → Reduces boilerplate with `@Data`, `@Builder`, etc.

PostgreSQL → Integrated via JPA/Hibernate with minimal config.
